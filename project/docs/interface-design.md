# sxml.js — Interface Design

> 基于 design.md 的 10 项核心决策，定义具体可实施的接口和类型

---

## 一、包结构

```
src/
  index.ts            # 公共导出
  types.ts            # 所有公共类型定义
  internal-types.ts   # 内部类型（L1/L2/L3 之间）
  sxml-parser.ts      # SxmlParser 主类（L3 逻辑）
  tokenizer.ts        # L1 字符级状态机
  xml-processor.ts    # L2 标签栈管理
```

npm 包名待定: `sxml.js` 或 `@sxml/core`

---

## 二、公共 API

### 2.1 SxmlParser

```typescript
class SxmlParser {
  constructor(config: SxmlConfig);

  /** 输入一个字符串 chunk，内部同步处理 */
  write(chunk: string): void;

  /** 标记输入流结束 */
  end(): void;

  /** 重置解析器到初始状态 */
  reset(): void;

  /**
   * 异步拉取：当有新事件或流结束时 resolve
   * - 有事件：resolve SxmlResult
   * - 流结束且无事件：resolve null
   * - 无事件但流未结束：返回挂起的 Promise，在下次 write() 后 resolve
   */
  pull(): Promise<SxmlResult | null>;

  /**
   * 同步拉取：立即返回可用事件
   * - 有事件：返回 SxmlResult
   * - 无事件：返回 null
   */
  tryPull(): SxmlResult | null;
}
```

**生命周期**:
```
new SxmlParser(config)
  → write(chunk) × N
  → end()
  → tryPull() 耗尽所有事件 (返回 null)
  (或 pull() 返回 Promise<null>)
  → reset() 可重新开始
```

**`write()` + `pull()` 交互**:
- `write()` 内部同步执行 L1→L2→L3 处理，将 SxmlResult 入队
- `write()` 处理完成后，如果有挂起的 `pull()` Promise，立即 resolve
- 如果 `end()` 后队列为空，挂起的 `pull()` resolve(null)
- `pull()` 在队列非空时立即 resolve；否则挂起

### 2.2 SxmlConfig

```typescript
interface SxmlConfig {
  /**
   * 合法标签名白名单。
   * 提供时：L1 仅识别白名单内的标签名，其他回退为 TEXT
   * 不提供时：回退到 tagCharPattern 正则校验
   *
   * 推荐 LLM 场景使用，精确控制哪些 XML 标签被解析
   */
  legalTags?: string[];

  /**
   * 标签名字符正则（仅 legalTags 未提供时生效）
   * 用于校验 TAG_NAME 中每个字符是否合法
   * @default /^[a-zA-Z0-9_\-.:]$/
   */
  tagCharPattern?: RegExp;

  /**
   * 标签→业务事件的转换器（可选的覆盖配置）
   * key 为标签名，value 为 TagHandler
   *
   * legalTags 中的标签默认使用 DefaultTagHandler：
   *   → { type: tagName, name: tagName, ...attributes, content: "childrenText" }
   * 如需自定义行为才在此配置 handler
   */
  tagHandlers?: Record<string, TagHandler>;

  /**
   * 标签嵌套解析的最大深度。
   * 0 = 只解析根标签，1 = 解析根+直接子标签，以此类推
   * 超出此深度的 <...> 保留为原始 XML 文本
   * @default 1
   */
  maxNestingDepth?: number;

  /**
   * 缓冲区最大大小（字节数）
   * @default 1048576 (1MB)
   */
  maxBufferSize?: number;

  /**
   * 错误处理策略
   * @default ErrorStrategy.LENIENT
   */
  errorStrategy?: ErrorStrategy;
}
```

### 2.3 SxmlResult

```typescript
/**
 * 增量 Patch：指示消费方如何更新其事件列表
 *
 * 消费方维护一个 SxmlEvent[]，对每个 SxmlResult 执行：
 *   if (result.update === null) events.pop();
 *   else if (result.update !== undefined) events[events.length - 1] = result.update;
 *   events.push(...result.append);
 */
interface SxmlResult {
  /** 替换事件列表最后一个元素（最多一个） */
  update?: SxmlEvent | null;

  /** 追加到事件列表尾部（0~N 个） */
  append: SxmlEvent[];
}
```

**约定**:
- `update` 永远指向外部事件列表的**最后一个元素**，不会指向更早的位置
- `append` 为空数组时正常（例如仅 update 无 append）
- `update` 为 undefined 时表示无替换
- `null` 返回值表示流结束且无更多事件

### 2.4 SxmlEvent

```typescript
/** 对外暴露的事件类型 */
type SxmlEvent = TextEvent | BusinessEvent;

/** 文本事件 */
interface TextEvent {
  type: 'text';
  content: string;
}

/**
 * 业务事件（由 TagHandler.build() 产生）
 *
 * 约束：
 * - type 字段为标签名
 * - 其余字段由 TagHandler 决定
 * - 不暴露 XML 语义（无 elementOpen/elementClose 等概念）
 */
interface BusinessEvent {
  type: string;
  [key: string]: unknown;
}
```

### 2.5 DefaultTagHandler（内置默认）

legalTags 中的每个标签，若未在 `tagHandlers` 中显式配置，则使用此默认行为：

```typescript
const DefaultTagHandler: TagHandler = {
  build(tagName, attributes, children) {
    // 1. 拼接所有 text 子节点的内容
    const content = children
      .filter(c => c.type === 'text')
      .map(c => (c as TextEvent).content)
      .join('');

    // 2. 嵌套子标签的 BusinessEvent 收纳为父事件的属性
    const nestedAttrs: Record<string, unknown> = {};
    for (const c of children) {
      if (c.type !== 'text') {
        const be = c as BusinessEvent;
        // 属性 key 为子标签名，值为子标签的 content
        nestedAttrs[be.type] = (be as any).content ?? '';
      }
    }

    return {
      type: tagName,
      name: tagName,
      ...attributes,
      ...nestedAttrs,
      content,
    };
  }
};
```

**示例 1 — 基本用法**：

```
输入: <tool_call name="calc">2+2</tool_call>
config: { legalTags: ['tool_call'] }  // 无显式 tagHandlers

输出:
  { type: 'tool_call', name: 'tool_call', name: 'calc', content: '2+2' }
```

**示例 2 — 一层嵌套（子标签收纳为父属性）**：

```
输入: <parent><child>hello</child></parent>
config: { legalTags: ['parent', 'child'] }

最终事件:
  { type: 'parent', name: 'parent', content: '', child: 'hello' }
```

**嵌套深度限制**：默认只解析 1 层嵌套。深度 ≥ 2 的 `<...>` 不再解析为标签，整体保留为原始 XML 文本。

```
输入: <1><2><3>deep</3></2></1>
config: { legalTags: ['1', '2', '3'] }

处理:
  - <1> 深度 0: 解析为标签 ✓
  - <2> 深度 1: 解析为标签 ✓
  - <3> 深度 2: 超过 maxNestingDepth，<3>deep</3> 保留为原始文本
  
  <2> 闭合 → { type: '2', name: '2', content: '<3>deep</3>' }
  <1> 闭合 → { type: '1', name: '1', content: '', '2': '<3>deep</3>' }
```

详见 5.9 节。

### 2.5 TagHandler

```typescript
interface TagHandler {
  /**
   * 将闭合的 XML 元素转换为业务事件
   *
   * @param tagName   - 标签名
   * @param attributes - 标签属性（已完整解析，Record<string, string>）
   * @param children   - 子事件列表（已递归由各自 TagHandler 处理完毕）
   * @returns 业务事件；返回 null 表示丢弃此标签
   */
  build(
    tagName: string,
    attributes: Record<string, string>,
    children: SxmlEvent[]
  ): SxmlEvent | null;
}
```

**children 说明**:
- children 中的文本节点为 `TextEvent`
- children 中的子元素已经是处理后的 `BusinessEvent`
- children 顺序保持 XML 原始顺序
- 空的 children 为 `[]`

### 2.6 ErrorStrategy

```typescript
enum ErrorStrategy {
  /** 严格模式：遇到 XML 语法错误立即抛出异常（适合测试） */
  STRICT = 'strict',

  /** 宽容模式：跳过错误字符，发出 error 事件，继续解析（默认） */
  LENIENT = 'lenient',

  /** 静默模式：跳过错误字符，不报告（适合高性能场景） */
  SILENT = 'silent',
}
```

---

## 三、内部接口

### 3.1 L1: Tokenizer（字符级状态机）

**职责**: 逐字符推进状态机，处理 chunk 边界，确认标签后产出 XML 语义事件

**接口**:

```typescript
interface ITokenizer {
  write(chunk: string): void;
  end(): void;
  reset(): void;

  /** 拉取下一个已确认的 XML 事件 */
  pull(): TokenizerEvent | null;

  /**
   * 获取当前积累但未确认的文本
   * 用于 L3 的"未闭合标签文本预览"机制
   *
   * - 包含从上次 flush 位置到当前的所有新字符
   * - 也包含 TAG_SUSPECTED 状态下积累的标签文本
   */
  flushPendingText(): string;

  /** 当前是否处于 TAG_SUSPECTED 状态（已看到 < 但未确认） */
  isInTagSuspect(): boolean;

  /** 当前处于 TAG_SUSPECTED 时，`<` 在 pending text 中的偏移量 */
  suspectStartOffset(): number;

  /** 当前已开启但未闭合的标签数量（用于 maxNestingDepth 判断） */
  currentDepth(): number;

  /** 设置 maxNestingDepth（来自 config） */
  setMaxNestingDepth(depth: number): void;
}
```

**状态机状态**:

```
TEXT ──'<'──▶ TAG_SUSPECTED ──合法字符──▶ TAG_NAME
  ▲              │                            │
  │              │ 非法字符/end()             ├─空格──▶ AFTER_NAME
  │              ▼                            │        │
  │         回退为 TEXT                       │        ├─'/'─▶ BEFORE_CLOSE ──'>'─▶ emit selfClose
  │                                           │        │
  │                                           │        ├─'>'─▶ 确认: emit elementOpen
  │                                           │        │
  │                                           │     ATTR_NAME ──'='──▶ ATTR_VALUE_START
  │                                           │        ▲                │
  │                                           │        │                ├─'"'/'"'──▶ ATTR_VALUE_DQ/SQ
  │                                           │        │                └─'>'─▶ 确认
  │                                           │        └──────────────────┘
  │                                           │
  │                           CLOSE_TAG_NAME ──'>'─▶ emit elementClose
  │
  └──其他字符──▶ 继续 TEXT
```

**事件类型**:

```typescript
type TokenizerEvent =
  | { type: 'text'; content: string }
  | { type: 'elementOpen'; name: string; attributes: Record<string, string> }
  | { type: 'elementClose'; name: string }
  | { type: 'selfClose'; name: string; attributes: Record<string, string> }
  | { type: 'error'; message: string };
```

**关键行为**:
- `flushPendingText()`: 返回自上次调用以来所有未确认的新字符
  - TEXT 状态下直接返回积累的文本
  - TAG_SUSPECTED / TAG_NAME 状态下返回包括 `<` 在内的原始标签文本
  - 调用后内部标记"已 flush 位置"，下次只返回新增部分
- `suspectStartOffset()`: 返回 `<` 在 pending text 中的偏移，L3 用于回溯截断
- `pull()`: 返回已确认事件，无事件时返回 null
- `end()`: 将 TAG_SUSPECTED 中的所有文本回退为 TEXT 输出
- `currentDepth()`: 返回当前已确认但未闭合的标签数
  - L1 自身维护计数器：emit elementOpen → +1, emit elementClose/selfClose → -1
  - 遇到 `<` 时 check: `currentDepth() > maxNestingDepth` → 不进入 TAG_SUSPECTED，`<` 保留为 TEXT 字符
- `setMaxNestingDepth()`: 设置深度上限，L3 从 config 传入

### 3.2 L2: XmlProcessor（标签栈管理）

**职责**: 消费 L1 事件，维护标签栈，校验闭合匹配，产出增强的 XML 事件

**接口**:

```typescript
interface IXmlProcessor {
  /** 输入 L1 事件 */
  push(event: TokenizerEvent): void;

  /** 拉取 L2 事件 */
  pull(): XmlEvent | null;

  /** 获取当前未闭合标签栈深度 */
  depth(): number;

  /** 当前栈顶标签名（无则 null） */
  topTag(): string | null;
}
```

**事件类型**:

```typescript
type XmlEvent =
  | TokenizerEvent                        // text / error 直接透传
  | { type: 'elementOpen'; name: string; attributes: Record<string, string> }
  | { type: 'elementClose'; name: string };
```

**关键行为**:
- `elementOpen`: 将标签名压入栈
- `elementClose`:
  - 与栈顶匹配 → 弹出栈顶，emit elementClose
  - 与栈顶不匹配 → 根据 errorStrategy 报错或跳过
  - 栈为空时遇到 elementClose → 报错或忽略
- `end()` 时栈非空 → 根据 errorStrategy 报错或静默弹出

### 3.3 L3: SxmlParser（业务事件层）

**职责**: 消费 L2 事件，管理未闭合标签的文本预览，文本合并，TagHandler 调用

L3 集成在 SxmlParser 类中，不暴露独立接口。

**内部状态**:

```typescript
/** L3 维护的"影子事件列表"——模拟消费方的事件数组 */
interface L3State {
  shadowEvents: SxmlEvent[];

  /** 已确认但未闭合的标签栈，从底到顶 */
  openTagStack: OpenTagEntry[];

  /** 当前积累的原始文本（用于 text 合并和回溯） */
  pendingRawText: string;
}

interface OpenTagEntry {
  name: string;
  attributes: Record<string, string>;

  /** 此标签的子事件在 shadowEvents 中的起始位置 */
  childrenStartIndex: number;

  /** 此标签的原始文本在 shadowEvents[rawTextEventIndex] 中的起始偏移 */
  rawTextEventIndex: number;
  rawTextStartOffset: number;
}
```

**处理流程（每次 L2 事件到达时）**:

```
1. L2 event: text
   → 追加到 pendingRawText
   → 延迟输出（等到非 text 事件或 flush 时）

2. L2 event: elementOpen(name, attrs)
   → 将 pendingRawText（含开标签全文）追加到 shadowEvents
   → 记录 OpenTagEntry（rawTextEventIndex, rawTextStartOffset）
   → 推入 openTagStack
   → 输出 { update: lastTextEvent_withRawText } （无 append）
   → pendingRawText 清空

3. L2 event: elementClose(name)
   → 将 pendingRawText 追加到 shadowEvents
   → 从 openTagStack 弹出 entry
   → 提取 children = shadowEvents 中此标签范围内的所有事件（text + 子 BusinessEvent）
   → 截断 rawText：shadowEvents[entry.rawTextEventIndex].content
        = shadowEvents[entry.rawTextEventIndex].content[0..entry.rawTextStartOffset]
   → 删除 children 区域的 shadowEvents
   → 调用 TagHandler.build(name, attrs, children)
   → 产出 BusinessEvent

   关键分支：当前 depth 在 openTagStack 中的位置决定输出策略
   ┌─ depth == 0（根标签）: 直接输出
   │    { update: 截断后text, append: [BusinessEvent] }
   │
   ├─ depth > 0 && parent 使用 DefaultTagHandler:
   │    将 BusinessEvent 暂存到 parent entry.pendingChildren[]
   │    只输出 { update: 截断后text } （无 append）
   │    （子事件将在父标签闭合时被 DefaultTagHandler 吸收为属性）
   │
   └─ depth > 0 && parent 使用自定义 TagHandler:
        直接输出 { update: 截断后text, append: [BusinessEvent] }
        （自定义 handler 在 build() 中自行决定如何利用 children）
   → pendingRawText 清空

4. L2 event: selfClose(name, attrs)
   → 短标签文本如 `<br/>` 先追加到 pendingRawText
   → 无需压栈，直接调用 TagHandler.build(name, attrs, [])
   → 回溯截断 pendingRawText 中的 `<br/>` 文本
   → 输出 { update: 截断后text, append: [业务事件] }
   → pendingRawText 清空

5. L2 event: error
   → LENIENT/SILENT: 跳过 or 记录
   → STRICT: throw
```

**Text 合并规则**:
- 连续的 text 事件自动合并：扩展最后一个 text 的 content
- pendingRawText 与 shadowEvents[-1] 若为 text 类型则合并
- 输出时：若 shadowEvents[-1] 为 text 且内容增长 → `{ update }`；否则 `{ append }`

**TryPull 实现**:

```typescript
tryPull(): SxmlResult | null {
  // 1. 先 flush L1 的 pending text
  const pendingText = this.tokenizer.flushPendingText();
  if (pendingText) {
    // 延迟到 shadowEvents，等待合并或确认
    this.pendingRawText += pendingText;
  }

  // 2. 处理 L1 → L2 事件
  let l1Event;
  while ((l1Event = this.tokenizer.pull()) !== null) {
    this.xmlProcessor.push(l1Event);
  }
  let l2Event;
  while ((l2Event = this.xmlProcessor.pull()) !== null) {
    this.processL2Event(l2Event);  // 可能产出 result
    if (this.hasResult) return this.dequeueResult();
  }

  // 3. 如果没有 L2 事件，但 pendingRawText 有内容
  //    → 输出为 text 事件（增量）
  if (this.pendingRawText) {
    return this.emitPendingText();
  }

  return null;
}
```

**pull() 实现**:

```typescript
async pull(): Promise<SxmlResult | null> {
  const result = this.tryPull();
  if (result !== null) return result;
  if (this._ended && this._queue.length === 0) return null;

  // 挂起 Promise，等待下次 write()
  return new Promise(resolve => {
    this._pendingResolve = resolve;
  });
}
```

---

## 四、完整事件流示例

以 design.md 中的示例走一遍完整流程：

```
输入 chunks:
  '让我思考一下'  →  ' <think'  →  '>需要计算'  →  ' 2+2</think>'

chunk 1: '让我思考一下'
  L1: flushPendingText → '让我思考一下'
  L3: pendingRawText = '让我思考一下'
  L3: emitPendingText → { append: [{ type:'text', content:'让我思考一下' }] }

chunk 2: '<think'
  L1: '<' → TAG_SUSPECTED, flushPendingText → '<think'
  L1: pull() → null (tag 未确认)
  L3: pendingRawText = '<think'
  L3: emitPendingText → { update: { type:'text', content:'让我思考一下<think' } }

chunk 3: '>需要计算'
  L1: '>' → 确认 elementOpen('think', {}), flushPendingText → '' (已在事件中)
  L1: pull() → { type:'elementOpen', name:'think', attributes:{} }
  L2: push → push to stack, pull() → elementOpen 事件
  L3: processL2Event(elementOpen):
    - 将 pendingRawText('') 追加
    - 记录 OpenTagEntry: rawTextEventIndex=0, rawTextStartOffset=5 (tag 在 shadowEvents[0].content 中的起始位置)
      shadowEvents[0].content = '让我思考一下<think>'
      其中 '让我思考一下' 有 6 个字符... 

  等等，让我重新计算偏移量。

  chunk1: '让我思考一下' (6 chars) + chunk2: '<think' (6 chars) + chunk3: '>' (1 char)
  → shadowEvents[0] = { type:'text', content:'让我思考一下<think>' }
  → 加上 chunk3 的 '>' → content 变为 '让我思考一下<think>'
  
  现在 L1 继续处理 '需要计算':
  L1: TEXT 状态，flushPendingText → '需要计算'
  L3: pendingRawText = '需要计算'

  L3 在 chunk 处理完后输出:
  如果立即 emit: { update: { type:'text', content:'让我思考一下<think>需要计算' } }
  或者只在 tryPull 时输出...

```

Hmm, 我在文档中应该更精确地描述时序。让我简化示例，聚焦于接口行为而非内部细节。

### 简化版事件流

| 步骤 | write() 输入 | tryPull() 输出 |
|------|-------------|----------------|
| 1 | `让我思考一下` | `{ append: [text("让我思考一下")] }` |
| 2 | `<think` | `{ update: text("让我思考一下<think") }` |
| 3 | `>需要计算` | `{ update: text("让我思考一下<think>需要计算") }` |
| 4 | ` 2+2</think>` | `{ update: text("让我思考一下"), append: [think("需要计算 2+2")] }` |

步骤 4 的 append 由 think 的 TagHandler 产生（假设返回 `{ type: 'think', content: '需要计算 2+2' }`）。

---

## 五、特殊场景行为定义

### 5.1 嵌套标签（默认深度 1）

```
输入: <outer>before<inner>content</inner>after</outer>
config: { legalTags: ['outer', 'inner'] }  // 均使用默认 handler
```

| 步骤 | tryPull() 输出 |
|------|---------------|
| `<outer>` | `{ append: [text("<outer>")] }` |
| `before<inner>` | `{ update: text("<outer>before<inner>") }` |
| `content</inner>` | `{ update: text("<outer>before"), append: [{ type:'inner', name:'inner', content:'content' }] }` |
| `after</outer>` | `{ update: null, append: [{ type:'outer', name:'outer', content:'beforeafter', inner:'content' }] }` |

最终消费方事件列表：
```js
[
  { type: 'text', content: '' },
  { type: 'outer', name: 'outer', content: 'beforeafter', inner: 'content' }
]
```

注意：inner 事件被 outer 的默认 handler 收纳为属性，inner 不再作为独立事件出现在最终列表中。

### 5.2 默认 TagHandler 行为

```
config: { legalTags: ['my_tag'] }  // 无显式 tagHandlers
输入: <my_tag key="val">hello world</my_tag>
```

- `<my_tag key="val">` 和 `hello world` 和 `</my_tag>` 先作为 text 流式输出
- 标签闭合时，触发 DefaultTagHandler，回溯替换：
  - `{ update: text(截断后), append: [{ type:'my_tag', name:'my_tag', key:'val', content:'hello world' }] }`

**规则**: legalTags 中的所有标签默认都有 handler，无需显式配置即可产出业务事件

### 5.3 未知标签（不在 legalTags 中 / 不匹配 tagCharPattern）

```
输入: <unknown>text</unknown>
```

- `<` 后 L1 检查 tagCharPattern，若 `u`、`n` 等字符合法 → 继续解析
- 确认是合法 XML 标签（看到 `>`）→ L2 当作 elementOpen 处理
- 但如果 `unknown` 不在 legalTags 中且未匹配 tagCharPattern → 回退为 TEXT
- 整体作为 text 输出

**注意**: legalTags 白名单和 tagCharPattern 正则的逻辑：
  - 提供 legalTags → 只认白名单内的标签，其余回退 TEXT
  - 仅提供 tagCharPattern → 标签名匹配正则即可识别为标签
  - 均未提供 → 默认 tagCharPattern = `/^[a-zA-Z0-9_\-.:]$/`

### 5.4 自闭合标签

```
输入: <br/>  或  <br />
```

- L1 在 TAG_NAME 后看到 `/` 进入 BEFORE_CLOSE，随后 `>` 确认自闭合
  - 也支持 `<br />`（`/` 前有空格）
- 产生事件: `elementOpen(name='br', attributes={})` + 隐式 `elementClose(name='br')`
- 或者独立事件: `selfClose(name='br', attributes={})`（实现时选择一种）

具体实现选择：用独立的 `selfClose` 事件类型，L2 不压栈，直接透传：

```typescript
type TokenizerEvent = 
  | ...
  | { type: 'selfClose'; name: string; attributes: Record<string, string> };
```

- L2 收到 `selfClose`→ 不压栈，直接透传
- L3 收到 `selfClose` → 调用 TagHandler.build(name, attrs, []) → 业务事件
- 无需回溯（自闭合标签的 `<br/>` 文本本身很短，回溯替换开销小）

### 5.5 属性中的引号

```
输入: <tool_call name="read" args='{"key":"val"}'>
```

- L1 ATTR_VALUE 状态追踪当前分隔符（`"` 或 `'`）
- 遇到匹配的结束引号时退出 ATTR_VALUE
- 引号不会嵌套
- 属性值中的 `>` 不触发标签确认

### 5.6 流中断在属性中间

```
chunk1: <tool_call name="re
chunk2: ad">
```

- L1 在 chunk1 结尾保持 ATTR_VALUE 状态
- chunk2 到达后继续解析
- flushPendingText 返回整个 `<tool_call name="read">` 原始文本
- 属性最终值为 `"read"`（完整）

### 5.7 end() 处理

```
输入: <think  （没有 '>'）
parser.end()
```

- L1 end() 将 TAG_SUSPECTED 回退为 TEXT
- 最终输出: text("<think")
- pull()/tryPull() 返回 null 表示流结束

### 5.8 超长缓冲区

```
config: { maxBufferSize: 1024 }
输入: 一个 2KB 的 chunk
```

- write() 处理时检测缓冲区大小超过 maxBufferSize
- 当前策略: **抛出错误**（根据 design.md 决策 10，建议报错）
- 后续可扩展：截断选项

### 5.9 嵌套深度限制

`maxNestingDepth` 控制标签解析的最大嵌套深度（默认 1）。

**深度计数规则**：
- 根标签深度 = 0
- 直接子标签深度 = 1
- 超出 maxNestingDepth 的 `<...>` 不再解析为标签，保留为原始 XML 文本

**示例**（maxNestingDepth = 1）：

```
输入: <1>before<2>mid<3>deep</3>end</2>after</1>
config: { legalTags: ['1', '2', '3'] }

L1 处理逻辑:
  - 初始 depth = 0
  - '<1>' → 深度 0 ≤ 1 → 解析为 elementOpen('1')
  - depth = 1
  - '<2>' → 深度 1 ≤ 1 → 解析为 elementOpen('2')
  - depth = 2
  - '<3>' → 深度 2 > 1 → 不进入 TAG_SUSPECTED，<3>deep</3> 全部作为 TEXT
  - '</2>' → 闭合 depth=1 标签
  - depth = 1
  - '</1>' → 闭合 depth=0 标签

最终事件:
  <2> → { type:'2', name:'2', content:'<3>deep</3>' }
  <1> → { type:'1', name:'1', content:'beforeend', '2': '<3>deep</3>' }
```

**配置为 0（只解析根标签）**：

```
config: { maxNestingDepth: 0, legalTags: ['root', 'child'] }
输入: <root><child>text</child></root>

  - '<root>' → 深度 0 ≤ 0 → 解析为 elementOpen('root')
  - depth = 1
  - '<child>' → 深度 1 > 0 → 作为 TEXT
  - '</root>' → 闭合
  → { type:'root', name:'root', content:'<child>text</child>' }
```

**自定义 handler 不受此限**：自定义 TagHandler 的 `children` 参数中可能包含 `<` 原始文本（当子标签深度超限时），handler 可自行决定如何处理。

---

## 六、完整 TypeScript 类型定义

```typescript
// ============================================================
// 公共类型
// ============================================================

/** 错误处理策略 */
enum ErrorStrategy {
  STRICT = 'strict',
  LENIENT = 'lenient',
  SILENT = 'silent',
}

/** 解析器配置 */
interface SxmlConfig {
  legalTags?: string[];
  tagCharPattern?: RegExp;          // default: /^[a-zA-Z0-9_\-.:]$/
  tagHandlers?: Record<string, TagHandler>;
  maxBufferSize?: number;            // default: 1048576
  errorStrategy?: ErrorStrategy;     // default: 'lenient'
}

/** TagHandler — 业务事件构建器 */
interface TagHandler {
  build(
    tagName: string,
    attributes: Record<string, string>,
    children: SxmlEvent[]
  ): SxmlEvent | null;
}

/** 对外事件类型 */
type SxmlEvent = TextEvent | BusinessEvent;

interface TextEvent {
  type: 'text';
  content: string;
}

interface BusinessEvent {
  type: string;
  [key: string]: unknown;
}

/** 增量 Patch */
interface SxmlResult {
  update?: SxmlEvent | null;
  append: SxmlEvent[];
}

// ============================================================
// 内部类型（不对外暴露）
// ============================================================

/** L1 分词器事件 */
type TokenizerEvent =
  | { type: 'text'; content: string }
  | { type: 'elementOpen'; name: string; attributes: Record<string, string> }
  | { type: 'elementClose'; name: string }
  | { type: 'error'; message: string };

/** L1 分词器状态 */
enum TokenizerState {
  TEXT = 'TEXT',
  TAG_SUSPECTED = 'TAG_SUSPECTED',
  TAG_NAME = 'TAG_NAME',
  AFTER_NAME = 'AFTER_NAME',
  ATTR_NAME = 'ATTR_NAME',
  BEFORE_ATTR_EQ = 'BEFORE_ATTR_EQ',
  ATTR_VALUE_START = 'ATTR_VALUE_START',
  ATTR_VALUE_DQ = 'ATTR_VALUE_DQ',     // 双引号值
  ATTR_VALUE_SQ = 'ATTR_VALUE_SQ',     // 单引号值
  BEFORE_CLOSE = 'BEFORE_CLOSE',       // 看到 / 在 > 前
  CLOSE_TAG_NAME = 'CLOSE_TAG_NAME',   // </xxx
}

/** L2 XML 事件（与 L1 同型，增加 tag stack context） */
type XmlEvent = TokenizerEvent;

/** L3 内部标签栈条目 */
interface OpenTagEntry {
  name: string;
  attributes: Record<string, string>;
  childrenStartIndex: number;
  rawTextEventIndex: number;
  rawTextStartOffset: number;
  depth: number;
  /** 暂存子标签的 BusinessEvent（DefaultTagHandler 吸收用） */
  pendingChildren: SxmlEvent[];
}
```

---

## 七、已确认的设计决策（补充 design.md）

1. **自闭合标签**: 支持 `<tag/>` 和 `<tag />`（含空格变体）
2. **CDATA / 注释 / 处理指令**: MVP 不支持，遇到 `<![CDATA[`、`<!--`、`<?` 视为 TEXT
3. **XML 实体**: 不解码，直接保留原始文本
4. **Text 分片**: 不做长度限制，由消费方决定
5. **嵌套同名标签**: 支持，通过标签栈正确匹配
6. **Children 顺序**: 文本和业务事件交替出现时保持 XML 原始顺序，由 TagHandler 决定如何处理
7. **legalTags 优先级**: legalTags > tagCharPattern；提供 legalTags 时 tagCharPattern 不生效

