export interface CastSigner {
  env: Record<string, string>;
  extraArgs: string[];
}

export function resolveCastSigner(): CastSigner {
  const unlocked = (process.env['ARENA_CAST_USE_UNLOCKED'] ?? '').trim() === '1';
  if (unlocked) {
    const from = process.env['ARENA_CAST_FROM']?.trim() || process.env['ETH_FROM']?.trim();
    if (!from) {
      throw new Error('ARENA_CAST_USE_UNLOCKED=1 requires ARENA_CAST_FROM (or ETH_FROM)');
    }
    return { env: {}, extraArgs: ['--unlocked', '--from', from] };
  }

  const keystore = process.env['SYNAPTEX_SIGNER_KEYSTORE']?.trim();
  const password = process.env['SYNAPTEX_SIGNER_PASSWORD']?.trim();
  if (keystore) {
    const extraArgs = ['--keystore', keystore];
    if (password) extraArgs.push('--password', password);
    return { env: {}, extraArgs };
  }

  const privateKey = process.env['SYNAPTEX_SIGNER_PRIVATE_KEY']?.trim()
    || process.env['ARENA_SETTLER_PRIVATE_KEY']?.trim()
    || '';
  if (!privateKey) {
    throw new Error(
      'Missing signer credentials: set SYNAPTEX_SIGNER_KEYSTORE (preferred), '
      + 'or SYNAPTEX_SIGNER_PRIVATE_KEY/ARENA_SETTLER_PRIVATE_KEY, '
      + 'or ARENA_CAST_USE_UNLOCKED=1 with ARENA_CAST_FROM'
    );
  }
  const allowInsecure = (process.env['SYNAPTEX_ALLOW_INSECURE_PRIVATE_KEY'] ?? '').trim() === '1';
  if (!allowInsecure) {
    throw new Error(
      'Raw private-key signer is blocked by default. '
      + 'Use SYNAPTEX_SIGNER_KEYSTORE (recommended), '
      + 'or unlocked mode (ARENA_CAST_USE_UNLOCKED=1 + ARENA_CAST_FROM), '
      + 'or explicitly set SYNAPTEX_ALLOW_INSECURE_PRIVATE_KEY=1 to override.',
    );
  }
  // Foundry 1.6.0-rc1+ does not support ETH_PRIVATE_KEY env injection for
  // cast send. Passing via --private-key flag is the only direct option.
  // For production use, SYNAPTEX_SIGNER_KEYSTORE is strongly preferred — the
  // preflight check warns when raw private key env is detected.
  return { env: {}, extraArgs: ['--private-key', privateKey] };
}
