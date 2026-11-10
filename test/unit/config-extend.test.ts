// P8: another edition validates its own environment with the community parser and gets every
// problem (its own and the community's) in one ConfigError.
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type ConfigReader } from '../../src/config.ts';

const base = { PUBLIC_URL: 'http://localhost:4873' };

interface ExtensionConfig {
  licensePath: string | null;
  oidcIssuer: string;
  auditRetentionMs: number;
  seats: number;
  ssoRequired: boolean;
}

function extension(read: ConfigReader): ExtensionConfig {
  const issuer = read.url('OIDC_ISSUER');
  if (issuer.startsWith('http:')) read.problem('OIDC_ISSUER must use https');
  return {
    licensePath: read.str('LICENSE_PATH') ?? null,
    oidcIssuer: issuer,
    auditRetentionMs: read.duration('AUDIT_RETENTION', '90d'),
    seats: read.int('SEATS', 10, 1, 100_000),
    ssoRequired: read.bool('SSO_REQUIRED', true),
  };
}

describe('P8: loadConfig with extend', () => {
  it('returns the community config plus the typed extension', () => {
    const c = loadConfig(
      { ...base, OIDC_ISSUER: 'https://idp.example', SEATS: '25', LICENSE_PATH: '/l' },
      { extend: extension },
    );
    expect(c.publicUrl).toBe('http://localhost:4873');
    expect(c.extension).toEqual({
      licensePath: '/l',
      oidcIssuer: 'https://idp.example',
      auditRetentionMs: 90 * 86_400_000,
      seats: 25,
      ssoRequired: true,
    });
  });

  it('reports community and extension problems together', () => {
    let error: unknown;
    try {
      loadConfig(
        { PORT: 'nope', OIDC_ISSUER: 'http://idp.example', SEATS: '0', SSO_REQUIRED: 'yes' },
        { extend: extension },
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    expect(problems).toEqual(
      expect.arrayContaining([
        'PUBLIC_URL is required',
        expect.stringMatching(/^PORT must be an integer/) as unknown,
        'OIDC_ISSUER must use https',
        expect.stringMatching(/^SEATS must be an integer between 1 and 100000/) as unknown,
        'SSO_REQUIRED must be "true" or "false"',
      ]),
    );
  });

  it('passes the community config to the extension and keeps loadConfig(env) unchanged', () => {
    const seen: number[] = [];
    loadConfig(
      { ...base, OIDC_ISSUER: 'https://idp' },
      {
        extend: (read, community) => {
          seen.push(community.port);
          return extension(read);
        },
      },
    );
    expect(seen).toEqual([4873]);
    expect(loadConfig(base)).not.toHaveProperty('extension');
  });
});
