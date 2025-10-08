require('ts-node').register({
  transpileOnly: true,
  project: __dirname + '/tsconfig.json',
});
require('./index.ts');






