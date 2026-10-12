const API_ROOT = 'https://open.feishu.cn/open-apis';

// 非 JSON 响应（网关 5xx、限流/拦截页这类 HTML）在错误信息里留一小段正文，够定位就行。
function describeBody(text) { return `non-JSON body: ${String(text ?? '').replace(/\s+/gu, ' ').slice(0, 160)}`; }

export class FeishuClient {
  #token = null;

  constructor({ appId, appSecret, appToken, tableId, transport = fetch }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.tableId = tableId;
    this.transport = transport;
  }

  /**
   * 响应解析的统一入口：**先取正文、再尝试解析**。
   *
   * 不能直接写 `await response.json()`：服务端（或中间的网关 / 限流拦截页）回 HTML 时，
   * `json()` 抛的是 `Unexpected token '<', "<!DOCTYPE "...`，**把真实 HTTP 状态码一起吞掉** ——
   * 事后只剩一句语法错误，无法区分 429 限流还是 502/503 网关故障。
   * 2026-10-06 商品链实测：盖文淘宝/底单 写成功、写后回读收到 HTML，判因时就只剩这一句。
   */
  async #readPayload(response) {
    const text = await response.text();
    try { return { payload: JSON.parse(text), text }; } catch { return { payload: null, text }; }
  }

  async #tenantToken() {
    if (this.#token) return this.#token;
    const response = await this.transport(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const { payload, text } = await this.#readPayload(response);
    if (!payload || !response.ok || payload.code !== 0) {
      throw new Error(`Feishu authentication failed: ${response.status} ${payload ? `${payload.code ?? ''} ${payload.msg ?? ''}` : describeBody(text)}`.trim());
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
    const { payload, text } = await this.#readPayload(response);
    if (!payload || !response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${response.status} ${payload ? `${payload.code ?? ''} ${payload.msg ?? ''}` : describeBody(text)}`.trim());
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

  /**
   * 列出字段的**完整原始条目**（含 `property`，即 SingleSelect 的选项表）。
   *
   * 为什么另开一个而不是改 `listFields()`：`listFields()` 的返回形状已被多处断言逐字比对
   * （多一个 `property` 键就会让那些 `deepEqual` 变红）。这里只给真正需要选项表的调用方用。
   * 分页照 `listTables`/`listRecords` 的写法 —— 字段数超过 100 时静默截断会让
   * 「选项表少了几家店」变成一个看不见的缺口。
   */
  async listFieldItems() {
    const items = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.#request(`/bitable/v1/apps/${this.appToken}/tables/${this.tableId}/fields?${query}`);
      items.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return items;
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
