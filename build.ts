import dts from 'bun-plugin-dts'


await Bun.build({
  entrypoints: ["./src/cli.ts"],
  outdir: './dist/commands',
  target:"node",
  plugins: [
    dts()
  ],
})

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target:"node",
  plugins: [
    // dts()
  ],
})

// Generates `dist/index.d.ts` and `dist/other/foo.d.ts`