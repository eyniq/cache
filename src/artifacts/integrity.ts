// Streaming integrity verification (DESIGN.md section 5). Always computes sha512 as well, so
// artifacts can be content-addressed even when the registry only advertises sha1. Digests
// other than the built-in ones are verified by the adapter (EcosystemAdapter.createVerifier).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ArtifactIntegrity, BuiltinDigestAlgorithm } from '../core/contracts.ts';

export interface Verifier {
  update(chunk: Buffer): void;
  /** Finalises the digests; call once after the last chunk. */
  matches(): boolean;
  /** sha512 of the bytes seen, lowercase hex; valid after matches(). */
  sha512Hex(): string;
}

const HEX_LENGTH: Record<BuiltinDigestAlgorithm, number> = { sha512: 128, sha256: 64, sha1: 40 };

export function isBuiltinDigest(algorithm: string): algorithm is BuiltinDigestAlgorithm {
  return Object.hasOwn(HEX_LENGTH, algorithm);
}

/** A verifier for a built-in digest; an adapter-defined digest never matches here. */
export function createVerifier(expected: ArtifactIntegrity): Verifier {
  const sha512 = createHash('sha512');
  const builtin = isBuiltinDigest(expected.algorithm) ? expected.algorithm : null;
  const other = builtin === 'sha1' || builtin === 'sha256' ? createHash(builtin) : null;
  let sha512Digest: Buffer | null = null;
  return {
    update(chunk) {
      sha512.update(chunk);
      other?.update(chunk);
    },
    matches() {
      sha512Digest ??= sha512.digest();
      const actual = other ? other.digest() : sha512Digest;
      if (
        builtin === null ||
        !/^[0-9a-f]+$/.test(expected.hex) ||
        expected.hex.length !== HEX_LENGTH[builtin]
      ) {
        return false;
      }
      const want = Buffer.from(expected.hex, 'hex');
      return want.length === actual.length && timingSafeEqual(want, actual);
    },
    sha512Hex() {
      sha512Digest ??= sha512.digest();
      return sha512Digest.toString('hex');
    },
  };
}
