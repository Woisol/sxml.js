# sxml.js - 完整设计规格文档
# sxml.js — 流式 XML 解析工具 设计规格文档

> 版本: 1.0.0-draft
> 日期: 2026-05-03
> 定位: 面向大模型流式输出的增量式 XML 事件解析器，零依赖，纯 JS/TS 实现

---

## 一、项目背景与目标

### 1.1 问题定义

大模型（LLM）以流式方式输出结构化内容时（如 tool call、MCP 协议等），输出格式常为 XML。但 LLM 的输出是以**不定长字符串碎片（chunk）**形式到达的，可能在任意字符边界被截断（例如标签名写了一半、属性值没闭合等）。

现有 JS 生态中，没有一个库同时满足：
- 真正的增量 chunk 输入（跨 chunk 保持状态）
- 完整的 XML 语义支持
- 针对 LLM 流式场景优化（如未闭合标签的优雅处理）
- 活跃维护

### 1.2 核心目标

- 输入：不定长的字符串 chunk
- 输出：结构化的业务事件流，支持增量 patch
- 体验：未闭合的 XML 标签先作为普通文本流式展示，闭合后瞬间"编译"为结构化事件（类似 Markdown 预览）

### 1.3 项目名称

`sxml.js`（npm 包名: `sxml.js` 或 `@sxml/core`）

---

## 二、架构设计：三层架构

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Output Events (业务事件层)                      │
│                                                          │
│  - 未闭合标签：先作为 text 流式输出，闭合后 patch 替换     │
│  - 已闭合标签：通过 TagHandler 转换为业务事件              │
│  - 连续 text 事件：自动合并                               │
│  - 未知标签（非 legalTags 内）：回退为 text 输出           │
│                                                          │
│  对外接口: pull() / tryPull()                            │
│  返回格式: { update?: SxmlEvent, append: SxmlEvent[] } │
└──────────────────────┬──────────────────────────────────┘
                       │
                       │ L3 消费 L2 的事件，做标签识别、结构组装、text 合并
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2: XML Events (XML 语义层)                        │
│                                                          │
│  - 处理 XML 语法：标签开/闭、属性解析                     │
│  - 维护标签栈                                            │
│  - 事件类型: text / element / elementClose / error       │
│  - element 事件携带 closed 标记（是否已看到 '>'）         │
│                                                          │
│  内部接口不直接暴露给用户                               │
└──────────────────────┬──────────────────────────────────┘
                       │
                       │ L2 消费 L1 的字符流，做状态机解析，生成 XML 语义事件
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Chunk Buffer + Tokenizer (字符流层)            │
│                                                          │
│  - 状态机逐字符推进：TEXT / TAG_SUSPECTED / TAG_NAME /   │
│    AFTER_NAME / ATTR_NAME / ATTR_VALUE / BEFORE_CLOSE /  │
│    CLOSE_TAG_NAME / SELF_CLOSING 或者其它状态定义                         │
│  - 只有看到 '>' 才确认是标签，否则回退为 TEXT             │
│  - 支持 legalTags 白名单 / tagCharPattern 正则校验        │
│  - chunk 边界无缝拼接，状态跨 chunk 持久                  │
│  - 缓冲区大小可配置，超限时截断或报错                     │
│                                                          │
│  接口: write(chunk) / end() / reset()                    │
└─────────────────────────────────────────────────────────┘
```

### 各层职责总结

| 层     | 输入         | 输出                               | 核心职责                                                       |
| ------ | ------------ | ---------------------------------- | -------------------------------------------------------------- |
| **L1** | 字符串 chunk | XML 语义事件                       | 状态机解析、chunk 边界处理、`<` 的前瞻确认                     |
| **L2** | L1 的事件    | L2 事件（同类型，可能做校验/补全） | 标签栈管理、属性完整性、闭合标签匹配                           |
| **L3** | L2 的事件    | 增量 patch (`{update?, append[]}`) | 标签→业务事件转换、text 合并、未闭合标签的 text 预支与回溯替换 |

---

## 三、核心设计决策（讨论结论）

### 决策 1: Pull 模式作为主接口

- MVP 只做 Pull 模式，不提供 Push（SAX 风格的事件监听）
- 提供 `pull()interface SxmlResult | null>` 和 `tinterface SxmlResult | null` 两个方法
- `pull()` 在无新事件时返回挂起的 Promise，待新 chunk 到达后 resolve
- `tryPull()` 在无新事件时同步返回 `null`
- 如果未来需要 Push，可用 EventEmitter 包一层 Pull 实现

### 决策 2: 属性一次性给出

- `element` 事件中 `attributes: Record<string, string>` 一步到位
- 不做"每个属性一个事件"的细粒度流式

### 决策 3: `<` 的处理 —— 前瞻确认，只有 `>` 才确认是标签

- 看到 `<` 不立即进入 TAG_NAME 状态，态，先进入 `TAG_SUSPECTED` 状态
- 后续字符到达时：
  - 来了合法标签名字符 → 继续收集
  - 来了空格/`-`/`_`/`=`/`"`/`'`/`/` → 继续收集（属性部分）
  - **来了 `>` → 确认是标签**
  - 来了其它非法字符 → 回退为 TEXT
  - `end()` 被调用 → 回退为 TEXT
- 标签名合法性校验：
  - 优先使用 `legalTags` 白名单（推荐 LLM 场景使用  - 未提供 `legalTags` 时使用 `tagCharPattern` 正则（默认 `/[a-zA-Z0-9_\-]/`）
  - 遇到不合法字符直接回退到 TEXT 状态

### 决策 4: 未闭合标签的外层展示策略（核心交互）

这是整个工具最关键的体验设计：

1. L1 处于 `TAG_SUSPECTED` / `TAG_NAME` 等未确认状态时，L3 将积累的原始文本（如 `<tool_call name="read"`）作为普通 `text` 事件流式输出
2. L1 看到 `>` 确认是标签后，L3 不立即输出业务事件（因为还没闭合），继续将完整的开标签文本（如 `<tool_call name="read">`）作为 text 输出
3. 当 `elementClose` 到达，标签完整闭合时，L3 使用 update 返回属性**回溯修改**之前输出的 text 事件——把其中的标签原始文本截掉，然后在 `append` 中给出真正的业务事件

**UI 效果**：用户先看到原始 XML 文本在流式打字，标签闭合的瞬间，文本被替换为渲染后的结构化组件。类似 Markdown 编辑器的预览模式。

**L3 内部实现机制**：
- 维护 `pendingTag` 状态：记录"预支"为 text 的标签内容在 shadowEvents 中的位置和偏移量
- 维护 `openTagStack`：已确认但未闭合的标签信息
- 闭合时：截断 shadowEvents 中对应 text 的末尾 → 调用 TagHandler 构建业务事件 → 返回 `{ update: 截断后的text, append: [业务事件] }`

### 决策 5: 增量 Patch 接口格式

采用 `{ update?, append[] }` 结构，而非 `{index, event}[]`：
- `update`: 替换外部事件列表的最后一个元素（最多一个）
- `append`: 追加到外部事件列表尾部（0~N 个）
- 不需要 index 指向非末尾位置
- 返回 `null` 表示流结束且无更多事件

### 决策 6: 未知标签处理

- 不输出 `unknown_tag` 类型事件
- 无法识别的标签（不在 `legalTags` 中，或不符合 `tagCharPattern`）整体作为普通 text 输出
- 这由 L1 层的回退机制保证，L3 层不需要额外处理

### 决策 7: text 事件合并

- L3 层负责合并连续的 text 事件
- 即使 text 来自不同 chunk，要中间没有非 text 事件，就合并为一个

### 决策 8: 业务事件结构

外层事件不暴露 XML 语义（不出现 `elementOpen` / `elementClose`）
- 而是通过 `TagHandler` 转换为业务友好的扁平结构
- 例如: `{ type: "tool_call", name: "read_text", args: [] }`
- `type` 字段值就是标签名，其余字段由 `TagHandler.build()` 决定

### 决策 9: 错误处理策略

此项待定

```typescript
enum ErrorStrategy {
  /** 严格模式：遇到错误抛异常（用于测试） */
  STRICT,
  /** 宽容模式：跳过错误字符，符，发出 error 事件，解析（默认） */
  LENIENT,
  /** 静默模式：跳过错误字符，不报告（用于高性能场景） */
  SILENT,
}
```

### 决策 10: 缓冲区大小限制

- 支持通过配置参数控制缓冲区最大大小
- 超出限制时的行为待定（截断 or 报错），建议实现时报错

---


## 四、完整使用示例

```typescript
import { SxmlParser } from 'sxml.js';


const parser = new SxmlParser({
  legalTags: ['tool_call','think', 'answer'],
  tagHandlers: {
    tool_call: {
      build(tagName, attrs, children) {
        return {
          type: 'tool_call',
          name: attrs.name,
          args: children.filter(c => c.type === 'arg')
        };
      }
    },
    think: {
      build(tagName, attrs, children) {
        return {
          type: 'think',
          content: children.map(c => c.type === 'text' ? ? c.content : '').in('')
        };
      }
    }
  },
  maxBufferSize: 1024 * 1024,  // 1MB
});

const events: SxmlEvent[] = [];


// 模拟 LLM 流式输出
const chunks = [
  '让我思考一下',
  '<think',
  '>需要计算',
  ' 2+2</think>',
  '\n答案是 <tool_call name="calc">',
  '</tool_call>',
];

for (const chunk of chunks) {
  parser.write(chunk);
  let result;
  while ((result = parser.tryPull()) !== null) {
    if (result.update) {
      events[events.length - 1] = result.update;
    }
    events.push(...result.append);
  }
  console.log(`[after "${chunk}"]`, JSON.stringify(events,, null,2));
}

parser.end();

/* 预期输出:

[after "让我思考一下"]
[{ "type": "text",, "content": "让我思考一下" }]

after "<think"]
[{ "type": "text", "content": "让我思考一下<think" }]

[after ">需要计算"]
[{ "type": "text", "content": "让我思考一下