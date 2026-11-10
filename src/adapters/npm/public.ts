// Public npm helpers (`@eyniq/cache/npm`, also the `npm` namespace of `@eyniq/cache`). Narrow
// on purpose: a worker-thread module (EcosystemAdapter.processorModule) of another edition can
// wrap the npm processing without loading the server or the defaults barrel.
export {
  ABBREVIATED_CONTENT_TYPE,
  FULL_CONTENT_TYPE,
  parseIntegrity,
  parseWriteBody,
  processMetadata,
  renderMetadata,
} from './packument.ts';
export {
  isValidPackageName,
  isValidRev,
  isValidTag,
  isValidTarballFile,
  isValidVersion,
  unscopedName,
} from './names.ts';
export { compareVersions, prereleaseChannel } from './semver.ts';
export {
  NpmPrivateSource,
  PRIVATE_DOCUMENT_PREFIX,
  type NpmPrivateSourceOptions,
  type StoredDoc,
} from './private-source.ts';
export { inspectTarball, type TarballLimits, type TarballManifest } from './tarball-check.ts';
export { npmCatalog, safeHttpUrl } from './catalog.ts';
