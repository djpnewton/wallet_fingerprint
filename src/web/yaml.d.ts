/** The static build inlines rule YAML at bundle time (esbuild `text` loader). */
declare module '*.yaml' {
  const text: string;
  export default text;
}
