const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;
const MULTI_SELECT = 4;
const DATE = 5;
const ATTACHMENT = 17;

const select = (name, options) => ({
  name,
  type: SINGLE_SELECT,
  property: { options: options.map((option) => ({ name: option })) },
});

const multi = (name, options) => ({
  name,
  type: MULTI_SELECT,
  property: { options: options.map((option) => ({ name: option })) },
});

const field = (name, type = TEXT) => ({ name, type });

export const TABLE_DEFINITIONS = {
  '分析周次': [
    field('周次ID'),
    field('周开始日期', DATE),
    field('周结束日期', DATE),
    select('周状态', ['采集中', '待分析', '已发布', '已封存']),
    field('备注'),
  ],
  '竞品采集批次': [
    field('批次ID'),
    field('分析周次ID'),
    select('数据域', ['竞品', 'SKU', '问题']),
    field('搜索关键词'),
    field('采集开始时间', DATE),
    field('采集结束时间', DATE),
    field('页范围'),
    field('排序方式'),
    select('快照类型', ['full', 'resumed', 'mixed_snapshot']),
    select('完整性状态', ['待验证', '通过', '缺图', '失败']),
    field('源文件CSV'),
    field('源文件XLSX'),
    field('CSV SHA256'),
    field('XLSX SHA256'),
    field('公式版本'),
    field('AI提示词版本'),
    select('导入状态', ['待导入', '已导入', '已发布', '已拒绝']),
    field('源数据行数', NUMBER),
    field('嵌入图片数', NUMBER),
    field('备注'),
  ],
  '竞品周快照': [
    field('序号'), field('商品图片', ATTACHMENT), field('商品标题'), field('商品链接'),
    field('价格', NUMBER), field('月收货人数'), field('类目'), field('同款数'),
    field('平台'), field('占位类型'), field('店铺名'), field('店铺旺旺'),
    field('店铺类型'), field('地址'), field('收藏人数'), field('卖点'),
    field('批次ID'), field('商品ID'), field('快照唯一键'), field('来源时间', DATE),
    field('搜索关键词'), field('公式版本'), field('AI提示词版本'),
    select('是否有效竞品', ['是', '否', '待确认']),
    select('竞品分类', ['A-高销量高GMV竞品', 'B-高价值竞品', 'C-中价位竞品', 'D-低价位竞品', '无分类', '不适用']),
    field('月收货人数计算值', NUMBER),
    select('计算口径', ['精确值', '下限值', '不可计算']),
    field('月收货金额', NUMBER),
    select('客单价带分类', ['1000以下', '1000-3000', '3000-6000', '6000-8000', '8000以上']),
    multi('材质分类', ['亚克力', '人造石', '塑料', '陶瓷', '钢瓷', '铸铁', '透明', '木', '搪瓷', '无注明', '不适用']),
    multi('外形', ['椭圆', '方形', '蛋形', '异形', '正圆', '无注明', '不适用']),
    multi('安装方式', ['独立', '嵌入', '靠墙', '台上/搁置', '无注明', '不适用']),
    multi('功能', ['普通', '按摩', '智能', '恒温', '无注明', '不适用']),
    multi('风格', ['极简', '奶油', '日式', '轻奢', '无注明', '不适用']),
    field('尺寸'),
    multi('适用空间', ['小户型', '常规卫生间', '大户型', '无注明', '不适用']),
    select('数据状态', ['可用', '部分待补']),
    multi('待补数据项', ['月收货人数精确值', '材质分类', '外形', '安装方式', '功能', '风格', '尺寸', '适用空间', '是否有效竞品', 'SKU尺寸', '问大家', '评论']),
    field('排除原因'),
  ],
};

export const RELATION_DEFINITIONS = [
  { from: '竞品采集批次', fieldName: '分析周次', to: '分析周次', backFieldName: '竞品采集批次' },
  { from: '竞品周快照', fieldName: '采集批次', to: '竞品采集批次', backFieldName: '竞品周快照' },
  { from: '竞品周快照', fieldName: '所属竞品', to: '竞品主表', backFieldName: '竞品周快照关联' },
];

const normalizedField = (value) => ({
  fieldId: value.fieldId ?? value.field_id,
  fieldName: value.fieldName ?? value.field_name,
  type: Number(value.type),
  property: value.property ?? null,
});

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function buildSchemaPlan({ tables }) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const tablesToCreate = [];
  const fieldsToCreate = [];

  for (const [name, definitions] of Object.entries(TABLE_DEFINITIONS)) {
    const existing = byName.get(name);
    if (!existing) {
      tablesToCreate.push({ name, fields: definitions });
      continue;
    }
    const existingFields = new Map((existing.fields ?? []).map((item) => [
      normalizedField(item).fieldName,
      normalizedField(item),
    ]));
    for (const definition of definitions) {
      const current = existingFields.get(definition.name);
      if (!current) {
        fieldsToCreate.push({ tableId: existing.tableId ?? existing.table_id, tableName: name, field: definition });
        continue;
      }
      if (current.type !== definition.type) {
        throw new Error(`${name}.${definition.name} type mismatch: expected ${definition.type}, received ${current.type}`);
      }
    }
  }

  const relationsToCreate = RELATION_DEFINITIONS.filter((relation) => {
    const from = byName.get(relation.from);
    return from && !(from.fields ?? []).some((field) => (field.fieldName ?? field.field_name) === relation.fieldName);
  });

  return { tablesToCreate, fieldsToCreate, relationsToCreate, recordsWillBeWritten: false };
}

export function assertSchemaMutation({ method, path, body }, plan) {
  if (method === 'POST' && path.endsWith('/tables')) {
    const name = body?.table?.name;
    if (plan.tablesToCreate.some((table) => table.name === name)) return;
  }
  if (method === 'POST' && path.includes('/fields')) {
    const name = body?.field_name;
    if (plan.fieldsToCreate.some((item) => item.field.name === name && path.endsWith(`/tables/${item.tableId}/fields`))) return;
  }
  throw new Error(`Blocked competitor weekly schema mutation: ${method} ${path}`);
}

export function summarizeSchemaPlan(plan) {
  return {
    tablesToCreate: plan.tablesToCreate.map((table) => ({ name: table.name, fieldCount: table.fields.length })),
    fieldsToCreate: plan.fieldsToCreate.map((item) => ({ tableName: item.tableName, fieldName: item.field.name })),
    relationsToCreate: plan.relationsToCreate.map((item) => ({ ...item })),
    recordsWillBeWritten: false,
  };
}
