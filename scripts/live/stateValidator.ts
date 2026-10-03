export function assertTruthful(s: any) {
  if (s.projectState === 'COMPLETED' && s.overallProgressPct !== 100) {
    throw new Error('COMPLETED requires overallProgressPct===100');
  }
  if (s.projectState === 'COMPLETED' && s.currentStagePct !== 100) {
    throw new Error('COMPLETED requires currentStagePct===100');
  }
  if (s.projectState === 'DOWNLOAD_READY' && s.currentStagePct !== 100) {
    throw new Error('DOWNLOAD_READY requires currentStagePct===100');
  }
  if (s.release.assetUrl && s.release.assetUrl.includes('example/repo')) {
    throw new Error('Fake release URL detected');
  }
  if (s.finalDownloadUrl && s.finalDownloadUrl.includes('example/repo')) {
    throw new Error('Fake final download URL detected');
  }
  if (s.apkVerification === 'passed' || s.release.status === 'created' || s.projectState === 'DOWNLOAD_READY') {
    const hasReal = !!(s.release.assetUrl || s.finalDownloadUrl);
    if (!hasReal) {
      throw new Error('Artifact readiness claimed without real download URL');
    }
  }
}
