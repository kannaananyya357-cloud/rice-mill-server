const http = require('http');

// Test day-history for May 20 (should fetch from Firestore)
function testEndpoint(path, label) {
  return new Promise((resolve) => {
    const options = {
      host: 'localhost',
      port: 8000,
      path: path,
      method: 'GET'
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          const withData = parsed.filter(h => h.kwh > 0 || h.maxKVA > 0);
          console.log(`[${label}] Status: ${res.statusCode}, Total hours: ${parsed.length}, Hours with data: ${withData.length}`);
        } else {
          console.log(`[${label}] Status: ${res.statusCode}, Response: ${JSON.stringify(parsed).substring(0, 200)}`);
        }
        resolve();
      });
    });
    req.on('error', e => { console.error(`[${label}] Error:`, e.message); resolve(); });
    req.end();
  });
}

async function runTests() {
  await testEndpoint('/api/analysis/historical-usage?deviceId=RICE_MILL_001&days=7', 'historical-usage 7d');
  await testEndpoint('/api/analysis/day-history?deviceId=RICE_MILL_001&date=2026-05-20', 'day-history May20');
  await testEndpoint('/api/analysis/day-history?deviceId=RICE_MILL_001&date=2026-05-21', 'day-history May21');
  await testEndpoint('/api/analysis/day-history?deviceId=RICE_MILL_001&date=2026-05-14', 'day-history May14');
}

runTests().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
