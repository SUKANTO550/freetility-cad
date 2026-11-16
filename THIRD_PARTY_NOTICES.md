# Third-party notices

FreeTility CAD and FreeTility CAD PRO bundle these libraries unchanged. Each keeps its own licence; the full texts are next to the files.

| Library | Used by | Files | Licence |
|---|---|---|---|
| [three.js](https://threejs.org/) r170 | both apps | `web/lib/three.module.min.js` | MIT (`web/lib/LICENSE-three.txt`) |
| [Manifold](https://github.com/elalish/manifold) 3.0.1 (manifold-3d) | FreeTility CAD | `cad/src/main/assets/lib/manifold.*` | Apache-2.0 (`cad/src/main/assets/lib/LICENSE-manifold.txt`) |
| [Open CASCADE Technology](https://dev.opencascade.org/) via [opencascade.js](https://ocjs.org/), custom build `replicad-opencascadejs` 1.2.1 | FreeTility CAD PRO | `cadpro/src/main/assets/lib/replicad_single.*` | LGPL-2.1 (`cadpro/src/main/assets/lib/LICENSE-opencascade.txt`) |
| [Microsoft Edge WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2) | Windows app | NuGet package, restored at build time | Microsoft WebView2 SDK licence |
| AndroidX WebKit, AndroidX Core | Android apps | Gradle dependencies | Apache-2.0 |

The OpenCascade library is loaded as a separate WebAssembly file (`replicad_single.wasm`) and can be replaced with another build of the same API.
