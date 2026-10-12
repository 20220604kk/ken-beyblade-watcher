// Compatibility boundary only: the release does not contain a mock storefront.
export class FunboxSandbox {
  constructor({ port = 3210 } = {}) { this.port = port; }
  get collectionUrl() { return `http://127.0.0.1:${this.port}/funbox-sandbox/disabled`; }
  async load() {}
  status() { return { enabled: false, publishedCount: 0, products: [], orders: [] }; }
  async handle(request, response) {
    response.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '發佈版本不包含測試商店' }));
    return true;
  }
}
