import type { TrustedTypePolicy } from 'trusted-types/lib';

export let defaultTrustedTypePolicy: Pick<
  TrustedTypePolicy<{
    createHTML: (input: string) => string;
    createScriptURL: (input: string) => string;
    createScript: (input: string) => string;
  }>,
  'name' | 'createHTML' | 'createScript' | 'createScriptURL'
>;

export const registerWindowDefaultTrustedTypePolicy = () => {
  const factory = window.trustedTypes;
  if (!factory?.createPolicy) return;

  defaultTrustedTypePolicy =
    factory.defaultPolicy ??
    factory.createPolicy('default', {
      createHTML: (input) => input,
      createScriptURL: (input) => input,
      createScript: (input) => input,
    });
};
