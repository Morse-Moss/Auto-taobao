const API_ROOT = 'https://open.feishu.cn/open-apis';

export class FeishuClient {
  #token = null;

  constructor({ appId, appSecret, appToken, tableId, transport = fetch }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.tableId = tableId;
    this.transport = transport;
  }

  async #tenantToken() {
    if (this.#token) return this.#token;
    const response = await this.transport(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no tenant access token');
    return this.#token;
  }

  async #request(path, init = {}) {
    const token = await this.#tenantToken();
    const response = await this.transport(`${API_ROOT}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listFields() {
    const data = await this.#request(`/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/fields?page_size=100`);
    return (data.items ?? []).map((item) => ({
      fieldId: item.field_id,
      fieldName: item.field_name,
      type: item.type,
    }));
  }

  // 列出 Base 下的表。目的是让调用方能证明「我读写的 tableId 就是它自称的那张表」，
  // 而不是只信调用方传进来的名字。只读，无副作用。
  async listTables() {
    const tables = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.#request(`/bitable/v1/apps/${this.appToken}/tables?${query}`);
      tables.push(...(data.items ?? []).map((item) => ({ tableId: item.table_id, name: item.name })));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return tables;
  }

  async getRecordCount() {
    const data = await this.#request(`/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records?page_size=1`);
    return data.total ?? data.items?.length ?? 0;
  }

  async updateFieldType(fieldId, type) {
    await this.#request(`/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/fields/${fieldId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
  }

  async uploadFile({ name, bytes }) {
    const form = new FormData();
    form.append('file_name', name);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', this.appToken);
    form.append('size', String(bytes.length));
    form.append('file', new Blob([bytes]), name);
    const data = await this.#request('/drive/v1/medias/upload_all', { method: 'POST', body: form });
    return data.file_token;
  }

  async batchCreateRecords(fieldsList) {
    if (fieldsList.length === 0 || fieldsList.length > 500) {
      throw new Error(`Batch size must be between 1 and 500; received ${fieldsList.length}`);
    }
    const data = await this.#request(`/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records/batch_create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: fieldsList.map((fields) => ({ fields })) }),
    });
    return (data.records ?? []).map((record) => record.record_id);
  }

  // 批量更新既有记录。入参沿用飞书原生形状（[{ record_id, fields }]），
  // 因为调用方必须能在写之前把它拿去和「已审批的写入计划」做逐字段等值比对——
  // 把计划改写成别处定义的中间结构会让那次比对失去意义。
  async batchUpdateRecords(records) {
    if (records.length === 0 || records.length > 500) {
      throw new Error(`Batch size must be between 1 and 500; received ${records.length}`);
    }
    const data = await this.#request(`/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records/batch_update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    });
    return (data.records ?? []).map((record) => record.record_id);
  }

  async listRecords() {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.#request(`/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }
}
