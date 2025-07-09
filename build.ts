import dts from 'bun-plugin-dts'

await Bun.build({
  entrypoints: ['./index.ts'],
  outdir: './dist',
  target:"node",
  plugins: [
    dts()
  ],
})

// Generates `dist/index.d.ts` and `dist/other/foo.d.ts`