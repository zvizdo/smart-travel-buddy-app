const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));
  page.on('request', request => {
    if (request.url().includes('google-analytics.com')) {
      console.log('--- GA REQUEST DETECTED ---');
      console.log('URL:', request.url());
      console.log('PostData:', request.postData());
    }
  });

  await page.goto("https://smart-travel-buddy-365259031240.europe-west1.run.app/?debug_mode=1", { waitUntil: "networkidle2" });
  
  console.log("Navigated to page. Waiting 5s for analytics to initialize...");
  await new Promise(r => setTimeout(r, 5000));
  
  await browser.close();
})();
