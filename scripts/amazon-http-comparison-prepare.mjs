// Read-only native Node cross-check. No cart mutations or order submissions.
import { AmazonHttpCheckoutComparison } from './amazon-http-checkout-comparison.mjs';
const run = await AmazonHttpCheckoutComparison.consumeSession(process.argv[2]);
try { console.log(JSON.stringify(await run.prepare(),null,2)); }
catch (error) { console.log(JSON.stringify({error:error.message, ...run.summary()},null,2)); process.exitCode=1; }
