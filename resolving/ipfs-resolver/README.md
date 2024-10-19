# @pnpm/ipfs-resolver

> Resolver for ipfs-hosted packages

<!--@shields('npm')-->

[![npm version](https://img.shields.io/npm/v/@pnpm/ipfs-resolver.svg)](https://www.npmjs.com/package/@pnpm/ipfs-resolver)

<!--/@-->

## Installation

```
pnpm add @pnpm/ipfs-resolver
```

## Usage

<!--@example('./example.js')-->

```js
"use strict";
const createResolveFromNpm = require("@pnpm/ipfs-resolver").default;

const resolveFromNpm = createResolveFromNpm({});

resolveFromNpm({
  pref: "ipfs://bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m",
}).then((resolveResult) => console.log(JSON.stringify(resolveResult, null, 2)));
//> {
//    "id": "ipfs://bafkreidgvpkjawlxz6sffxzwgooowe5yt7i6wsyg236mfoks77nywkptdq",
//    "ipfs": {
//      "cid": "bafkreidgvpkjawlxz6sffxzwgooowe5yt7i6wsyg236mfoks77nywkptdq",
//      "multibase": "base32",
//      "version": "cidv1",
//      "multicodec": "raw",
//      "multihash": "sha256",
//      "digestHex": "66ABD4905977CFA452DF36339CEB13B89FD1EB4B06D6FCC2B952FFDB8B29F31C",
//      "link": "https://bafkreidgvpkjawlxz6sffxzwgooowe5yt7i6wsyg236mfoks77nywkptdq.ipfs.dweb.link"
//      "gateway": "https://dweb.link"
//    },
//    "resolution": {
//      "tarball": "https://bafkreidgvpkjawlxz6sffxzwgooowe5yt7i6wsyg236mfoks77nywkptdq.ipfs.dweb.link"
//    },
//    "resolvedVia": "ipfs"
//  }
```

<!--/@-->

## License

MIT
