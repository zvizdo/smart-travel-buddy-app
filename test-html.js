async function run() {
  const html = await fetch('https://smart-travel-buddy-365259031240.europe-west1.run.app/').then(r => r.text());
  const chunks = html.match(/\/_next\/static\/chunks\/[^\.]+\.js/g);
  if (!chunks) {
    console.log("No chunks found.");
    return;
  }
  for (const chunk of new Set(chunks)) {
    const js = await fetch('https://smart-travel-buddy-365259031240.europe-west1.run.app' + chunk).then(r => r.text());
    if (js.includes('G-42LD8YQQ61')) {
      console.log('FOUND MEASUREMENT ID IN:', chunk);
    }
  }
  console.log("Done checking main chunks.");
}
run();
