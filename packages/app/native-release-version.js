const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;
// A fork stamps its own prerelease shape, e.g. 0.7.2-fr.7. Upstream's pattern
// knows only stable and -beta.N, and every Expo config read goes through this
// file, so an unrecognised version breaks even `expo export --platform web` —
// which the daemon's bundled web UI build runs.
const forkVersionPattern = /^(\d+)\.(\d+)\.(\d+)-fr\.(\d+)$/;
const stableIosBuildSlot = 999;
const FDROID_ABI_VERSION_CODE_SUFFIXES = {
  "armeabi-v7a": 1,
  "arm64-v8a": 2,
  x86: 3,
  x86_64: 4,
};

function getNativeReleaseVersion(version) {
  const forkMatch = forkVersionPattern.exec(version);
  if (forkMatch) {
    const [, majorText, minorText, patchText, buildNumber] = forkMatch;
    const versionCode =
      Number(majorText) * 1_000_000 + Number(minorText) * 1_000 + Number(patchText);
    return {
      appVersion: `${Number(majorText)}.${Number(minorText)}.${Number(patchText)}`,
      // Not for Play Store: every fork build of one upstream version shares a
      // versionCode. Play requires it to increase per upload; TestFlight, which
      // is the fork's only mobile target, does not look at it.
      androidVersionCode: versionCode,
      // The fork build number is already monotonic, which is all App Store
      // Connect asks of CFBundleVersion. Upstream's 1..999 build slot is a
      // per-release counter and would run out.
      iosBuildNumber: buildNumber,
    };
  }

  const match = versionPattern.exec(version);
  if (!match) {
    throw new Error(`Cannot derive native release version from unsupported version: ${version}`);
  }

  const [, majorText, minorText, patchText, betaText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const betaNumber = betaText === undefined ? null : Number(betaText);

  if (minor > 999 || patch > 999) {
    throw new Error(`Cannot derive collision-free native version from: ${version}`);
  }
  if (betaNumber !== null && (betaNumber < 1 || betaNumber >= stableIosBuildSlot)) {
    throw new Error(`iOS beta number must be between 1 and 998: ${version}`);
  }

  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 0 ||
    versionCode * 10 + 9 > 2_100_000_000
  ) {
    throw new Error(`Derived Android versionCode is out of range: ${versionCode}`);
  }

  const iosBuildSlot = betaNumber ?? stableIosBuildSlot;
  const iosBuildNumber = versionCode * 1_000 + iosBuildSlot;
  if (!Number.isSafeInteger(iosBuildNumber)) {
    throw new Error(`Derived iOS buildNumber is out of range: ${iosBuildNumber}`);
  }

  return {
    appVersion: `${major}.${minor}.${patch}`,
    androidVersionCode: versionCode,
    iosBuildNumber: String(iosBuildNumber),
  };
}

function getFdroidVersionCodes(version) {
  const { androidVersionCode } = getNativeReleaseVersion(version);
  return Object.entries(FDROID_ABI_VERSION_CODE_SUFFIXES).map(([abi, suffix]) => ({
    abi,
    versionCode: androidVersionCode * 10 + suffix,
  }));
}

module.exports = {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
};
