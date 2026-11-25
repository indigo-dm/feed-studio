module.exports = async function waitForArtifact({
  list, artifactId, attempts = 13, delayMs = 5000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log
}) {
  if (artifactId && !/^\d+$/.test(String(artifactId))) throw new Error('Invalid Pages artifact ID');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const artifacts = await list();
      const matching = artifacts.filter((item) => (!artifactId || String(item.id) === String(artifactId)) &&
        item.name === 'github-pages' && !item.expired && item.size_in_bytes > 0);
      if (matching.length > 1) throw new Error('Multiple Pages artifacts found in this run');
      const found = matching[0];
      if (found) {
        log('Uploaded Pages artifact is visible to the GitHub API.');
        return found;
      }
    } catch (error) {
      if (![404, 408, 429, 500, 502, 503, 504].includes(Number(error.status))) throw error;
      log('Artifact API is temporarily unavailable; waiting before retry.');
    }
    if (attempt < attempts) {
      log('Waiting for uploaded Pages artifact metadata...');
      await sleep(delayMs);
    }
  }
  throw new Error('Uploaded Pages artifact did not become available within the wait limit');
};
