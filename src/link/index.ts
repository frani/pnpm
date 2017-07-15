import fs = require('mz/fs')
import path = require('path')
import symlinkDir = require('symlink-dir')
import exists = require('path-exists')
import logger, {rootLogger} from 'pnpm-logger'
import R = require('ramda')
import pLimit = require('p-limit')
import {InstalledPackage} from '../install/installMultiple'
import {InstalledPackages, TreeNode} from '../api/install'
import linkBins, {linkPkgBins} from './linkBins'
import {Package, Dependencies} from '../types'
import {Resolution, PackageContentInfo, Store} from 'package-store'
import resolvePeers, {DependencyTreeNode, DependencyTreeNodeMap} from './resolvePeers'
import logStatus from '../logging/logInstallStatus'
import updateShrinkwrap from './updateShrinkwrap'
import * as dp from 'dependency-path'
import {Shrinkwrap, DependencyShrinkwrap} from 'pnpm-shrinkwrap'
import removeOrphanPkgs from '../api/removeOrphanPkgs'
import linkIndexedDir from '../fs/linkIndexedDir'
import ncpCB = require('ncp')
import thenify = require('thenify')

const ncp = thenify(ncpCB)

export default async function (
  topPkgs: InstalledPackage[],
  rootNodeIds: string[],
  tree: {[nodeId: string]: TreeNode},
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
    bin: string,
    topParents: {name: string, version: string}[],
    shrinkwrap: Shrinkwrap,
    privateShrinkwrap: Shrinkwrap,
    makePartialPrivateShrinkwrap: boolean,
    production: boolean,
    optional: boolean,
    root: string,
    storePath: string,
    storeIndex: Store,
    skipped: Set<string>,
    pkg: Package,
    independentLeaves: boolean,
  }
): Promise<{
  linkedPkgsMap: DependencyTreeNodeMap,
  shrinkwrap: Shrinkwrap,
  privateShrinkwrap: Shrinkwrap,
  newPkgResolvedIds: string[],
}> {
  const topPkgIds = topPkgs.map(pkg => pkg.id)
  logger.info(`Creating dependency tree`)
  const pkgsToLink = await resolvePeers(tree, rootNodeIds, topPkgIds, opts.topParents, opts.independentLeaves)
  const newShr = updateShrinkwrap(pkgsToLink, opts.shrinkwrap, opts.pkg)

  await removeOrphanPkgs({
    oldShrinkwrap: opts.privateShrinkwrap,
    newShrinkwrap: newShr,
    prefix: opts.root,
    store: opts.storePath,
    storeIndex: opts.storeIndex,
  })

  let flatResolvedDeps =  R.values(pkgsToLink).filter(dep => !opts.skipped.has(dep.id))
  if (opts.production) {
    flatResolvedDeps = flatResolvedDeps.filter(dep => !dep.dev)
  }
  if (!opts.optional) {
    flatResolvedDeps = flatResolvedDeps.filter(dep => !dep.optional)
  }

  const filterOpts = {
    noDev: opts.production,
    noOptional: !opts.optional,
    skipped: opts.skipped,
  }
  const newPkgResolvedIds = await linkNewPackages(
    filterShrinkwrap(opts.privateShrinkwrap, filterOpts),
    filterShrinkwrap(newShr, filterOpts),
    pkgsToLink,
    opts
  )

  for (let pkg of flatResolvedDeps.filter(pkg => pkg.depth === 0)) {
    const symlinkingResult = await symlinkDependencyTo(pkg, opts.baseNodeModules)
    if (!symlinkingResult.reused) {
      rootLogger.info({
        added: {
          id: pkg.id,
          name: pkg.name,
          version: pkg.version,
        },
      })
    }
    logStatus({
      status: 'installed',
      pkgId: pkg.id,
    })
  }
  await linkBins(opts.baseNodeModules, opts.bin)

  let privateShrinkwrap: Shrinkwrap
  if (opts.makePartialPrivateShrinkwrap) {
    const packages = opts.privateShrinkwrap.packages || {}
    if (newShr.packages) {
      for (const shortId in newShr.packages) {
        const resolvedId = dp.resolve(newShr.registry, shortId)
        if (pkgsToLink[resolvedId]) {
          packages[shortId] = newShr.packages[shortId]
        }
      }
    }
    privateShrinkwrap = Object.assign({}, newShr, {
      packages,
    })
  } else {
    privateShrinkwrap = newShr
  }

  return {
    linkedPkgsMap: pkgsToLink,
    shrinkwrap: newShr,
    privateShrinkwrap,
    newPkgResolvedIds,
  }
}

function filterShrinkwrap (
  shr: Shrinkwrap,
  opts: {
    noDev: boolean,
    noOptional: boolean,
    skipped: Set<string>,
  }
): Shrinkwrap {
  let pairs = R.toPairs<string, DependencyShrinkwrap>(shr.packages)
    .filter(pair => !opts.skipped.has(pair[1].id || dp.resolve(shr.registry, pair[0])))
  if (opts.noDev) {
    pairs = pairs.filter(pair => !pair[1].dev)
  }
  if (opts.noOptional) {
    pairs = pairs.filter(pair => !pair[1].optional)
  }
  return {
    shrinkwrapVersion: shr.shrinkwrapVersion,
    registry: shr.registry,
    specifiers: shr.specifiers,
    packages: R.fromPairs(pairs),
  } as Shrinkwrap
}

async function linkNewPackages (
  privateShrinkwrap: Shrinkwrap,
  shrinkwrap: Shrinkwrap,
  pkgsToLink: DependencyTreeNodeMap,
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
    optional: boolean,
  }
): Promise<string[]> {
  const nextPkgResolvedIds = R.keys(shrinkwrap.packages)
  const prevPkgResolvedIds = R.keys(privateShrinkwrap.packages)

  // TODO: what if the registries differ?
  const newPkgResolvedIds = (
      opts.force
        ? nextPkgResolvedIds
        : R.difference(nextPkgResolvedIds, prevPkgResolvedIds)
    )
    .map(shortId => dp.resolve(shrinkwrap.registry, shortId))
    // when installing a new package, not all the nodes are analyzed
    // just skip the ones that are in the lockfile but were not analyzed
    .filter(resolvedId => pkgsToLink[resolvedId])

  const newPkgs = R.props<DependencyTreeNode>(newPkgResolvedIds, pkgsToLink)

  if (!opts.force && privateShrinkwrap.packages && shrinkwrap.packages) {
    // add subdependencies that have been updated
    // TODO: no need to relink everything. Can be relinked only what was changed
    for (const shortId of nextPkgResolvedIds) {
      if (privateShrinkwrap.packages[shortId] &&
        (!R.equals(privateShrinkwrap.packages[shortId].dependencies, shrinkwrap.packages[shortId].dependencies) ||
        !R.equals(privateShrinkwrap.packages[shortId].optionalDependencies, shrinkwrap.packages[shortId].optionalDependencies))) {
        const resolvedId = dp.resolve(shrinkwrap.registry, shortId)
        newPkgs.push(pkgsToLink[resolvedId])
      }
    }
  }

  if (!newPkgs.length) return []

  logger.info(`Adding ${newPkgs.length} packages to node_modules`)

  await Promise.all([
    linkAllModules(newPkgs, pkgsToLink, {optional: opts.optional}),
    (async () => {
      try {
        await linkAllPkgs(linkPkg, newPkgs, opts)
      } catch (err) {
        if (!err.message.startsWith('EXDEV: cross-device link not permitted')) throw err
        logger.warn(err.message)
        logger.info('Falling back to copying packages from store')
        await linkAllPkgs(copyPkg, newPkgs, opts)
      }
    })()
  ])

  await linkAllBins(newPkgs, pkgsToLink, {optional: opts.optional})

  return newPkgResolvedIds
}

const limitLinking = pLimit(16)

async function linkAllPkgs (
  linkPkg: (fetchResult: PackageContentInfo, dependency: DependencyTreeNode, opts: {
    force: boolean,
    baseNodeModules: string,
  }) => Promise<void>,
  alldeps: DependencyTreeNode[],
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
  }
) {
  return Promise.all(
    alldeps.map(async pkg => {
      const fetchResult = await pkg.fetchingFiles

      if (pkg.independent) return
      return limitLinking(() => linkPkg(fetchResult, pkg, opts))
    })
  )
}

async function linkAllBins (
  pkgs: DependencyTreeNode[],
  pkgMap: DependencyTreeNodeMap,
  opts: {
    optional: boolean,
  }
) {
  return Promise.all(
    pkgs.map(dependency => limitLinking(async () => {
      const binPath = path.join(dependency.hardlinkedLocation, 'node_modules', '.bin')

      const childrenToLink = opts.optional
          ? dependency.children
          : dependency.children.filter(child => !dependency.optionalDependencies.has(pkgMap[child].name))

      await Promise.all(
        R.props<DependencyTreeNode>(childrenToLink, pkgMap)
          .filter(child => child.installable)
          .map(child => linkPkgBins(path.join(dependency.modules, child.name), binPath))
      )

      // link also the bundled dependencies` bins
      if (dependency.hasBundledDependencies) {
        const bundledModules = path.join(dependency.hardlinkedLocation, 'node_modules')
        await linkBins(bundledModules, binPath)
      }
    }))
  )
}

async function linkAllModules (
  pkgs: DependencyTreeNode[],
  pkgMap: DependencyTreeNodeMap,
  opts: {
    optional: boolean,
  }
) {
  return Promise.all(
    pkgs
      .filter(dependency => !dependency.independent)
      .map(dependency => limitLinking(async () => {
        const childrenToLink = opts.optional
          ? dependency.children
          : dependency.children.filter(child => !dependency.optionalDependencies.has(pkgMap[child].name))

        await Promise.all(
          R.props<DependencyTreeNode>(childrenToLink, pkgMap)
            .filter(child => child.installable)
            .map(child => symlinkDependencyTo(child, dependency.modules))
        )
      }))
  )
}

async function linkPkg (
  fetchResult: PackageContentInfo,
  dependency: DependencyTreeNode,
  opts: {
    force: boolean,
    baseNodeModules: string,
  }
) {
  const pkgJsonPath = path.join(dependency.hardlinkedLocation, 'package.json')

  if (fetchResult.isNew || opts.force || !await exists(pkgJsonPath) || !await pkgLinkedToStore(pkgJsonPath, dependency)) {
    await linkIndexedDir(dependency.path, dependency.hardlinkedLocation, fetchResult.index)
  }
}

async function copyPkg (
  fetchResult: PackageContentInfo,
  dependency: DependencyTreeNode,
  opts: {
    force: boolean,
    baseNodeModules: string,
  }
) {
  const newlyFetched = await dependency.fetchingFiles

  const pkgJsonPath = path.join(dependency.hardlinkedLocation, 'package.json')
  if (newlyFetched || opts.force || !await exists(pkgJsonPath)) {
    await ncp(dependency.path, dependency.hardlinkedLocation)
  }
}

async function pkgLinkedToStore (pkgJsonPath: string, dependency: DependencyTreeNode) {
  const pkgJsonPathInStore = path.join(dependency.path, 'package.json')
  if (await isSameFile(pkgJsonPath, pkgJsonPathInStore)) return true
  logger.info(`Relinking ${dependency.hardlinkedLocation} from the store`)
  return false
}

async function isSameFile (file1: string, file2: string) {
  const stats = await Promise.all([fs.stat(file1), fs.stat(file2)])
  return stats[0].ino === stats[1].ino
}

function symlinkDependencyTo (dependency: DependencyTreeNode, dest: string) {
  dest = path.join(dest, dependency.name)
  return symlinkDir(dependency.hardlinkedLocation, dest)
}
