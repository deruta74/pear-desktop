export type TransitionMode = 'crossfade' | 'automix';
/** Fail closed on malformed settings; neither feature can run while both are enabled. */
export function exclusiveMixAllowed(
  mode: TransitionMode,
  enabled: boolean,
  plugins: unknown,
): boolean {
  if (
    enabled !== true ||
    !plugins ||
    typeof plugins !== 'object' ||
    Array.isArray(plugins)
  )
    return false;
  const other = mode === 'automix' ? 'crossfade' : 'automix';
  const descriptor = Object.getOwnPropertyDescriptor(plugins, other);
  if (!descriptor) return true;
  if (
    !('value' in descriptor) ||
    !descriptor.value ||
    typeof descriptor.value !== 'object'
  )
    return false;
  const flag = Object.getOwnPropertyDescriptor(descriptor.value, 'enabled');
  return !flag || ('value' in flag && flag.value === false);
}
