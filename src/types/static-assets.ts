// Allow importing HTML route manifests in TypeScript
declare module '*.html' {
  const manifest: any;
  export default manifest;
}

