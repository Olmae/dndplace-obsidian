import {build} from 'esbuild';
await build({entryPoints:['src/main.ts'],outfile:'main.js',bundle:true,external:['obsidian'],platform:'node',target:'es2022',format:'cjs',minify:true,sourcemap:false,logLevel:'info'});
