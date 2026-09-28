// src/index.ts
var COMMANDS = [
  "pdf2word",
  "pdf2excel",
  "pdf2ppt",
  "pdf2md",
  "pdf2txt",
  "pdf2imgpdf",
  "pdf2cad",
  "pdf2photo",
  "photo2pdf",
  "cad2pdf",
  "pdfsplit",
  "pdfmerge",
  "pdfcompress",
  "pdfwatermark",
  "pdfremovewatermark",
  "pdfencrypt"
];
function result(text, isError = false) {
  return { content: [{ type: "text", text }], ...isError ? { isError: true } : {} };
}
function localScript(ctx) {
  return `${ctx.host.pluginDir}/runner.mjs`;
}
async function invoke(ctx, request) {
  const response = await ctx.bridge.invoke("plugin_exec_run", {
    bin: "node",
    args: [localScript(ctx)],
    stdin: JSON.stringify(request),
    timeoutMs: request.action === "ocr" || request.action === "read_pdf" || request.action === "read_image" ? 9e5 : 3e5
  });
  if (response.code !== 0 || typeof response.stdout !== "string") {
    throw new Error(`\u672C\u673A WPS \u64CD\u4F5C\u672A\u80FD\u542F\u52A8\uFF1A${String(response.stderr ?? "").slice(0, 500)}`);
  }
  let data;
  try {
    data = JSON.parse(response.stdout);
  } catch {
    throw new Error("\u672C\u673A WPS \u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u7ED3\u679C");
  }
  if (data.ok !== true) throw new Error(data.error?.message ?? "\u672C\u673A WPS \u64CD\u4F5C\u5931\u8D25");
  return JSON.stringify(data.result, null, 2);
}
function guarded(ctx, request) {
  return invoke(ctx, request).then((text) => result(text), (error) => result(error instanceof Error ? error.message : String(error), true));
}
var emptySchema = { type: "object", additionalProperties: false, required: [], properties: {} };
function activate(ctx) {
  const dispose = [];
  let starting = null;
  async function bridge(request) {
    try {
      if (!starting) {
        starting = ctx.bridge.invoke("plugin_exec_spawn", {
          bin: "node",
          args: [`${ctx.host.pluginDir}/bridge.mjs`, "--serve", ctx.host.pluginDir],
          lifecycle: "plugin"
        });
      }
      try {
        await starting;
      } catch (error) {
        starting = null;
        throw error;
      }
      const response = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: [`${ctx.host.pluginDir}/bridge.mjs`, "--request"],
        stdin: JSON.stringify(request),
        timeoutMs: request.action === "create_document" ? 3e5 : request.action === "export_pdf" ? 24e4 : request.action === "open_document" ? 12e4 : 9e4
      });
      if (response.code !== 0 || typeof response.stdout !== "string") throw new Error("WPS \u672C\u673A\u8FDE\u63A5\u672A\u80FD\u8FD0\u884C");
      const data = JSON.parse(response.stdout);
      if (!data.ok) {
        if (["BRIDGE_UNAVAILABLE", "ECONNREFUSED"].includes(data.error?.code ?? "")) starting = null;
        throw new Error(data.error?.message ?? "WPS \u672C\u673A\u8FDE\u63A5\u5931\u8D25");
      }
      if (data.result?.ok === false) throw new Error(data.result.error?.message ?? "WPS \u64CD\u4F5C\u5931\u8D25");
      return result(JSON.stringify(data.result?.result ?? data.result, null, 2));
    } catch (error) {
      return result(error instanceof Error ? error.message : String(error), true);
    }
  }
  async function readOpenedDocument(host, action, args) {
    const read = () => bridge({ host, action, params: args });
    const first = await read();
    if (!first.isError || typeof args.path !== "string" || !/对应的 WPS 组件尚未连接|指定文件没有在对应的 WPS 组件中打开/.test(first.content[0]?.text ?? "")) return first;
    const opened = await bridge({ action: "open_document", params: { path: args.path } });
    return opened.isError ? opened : read();
  }
  dispose.push(ctx.tools.register({
    name: "wps_status",
    description: "\u68C0\u67E5\u672C\u673A WPS Office \u662F\u5426\u53EF\u7528\uFF0C\u5E76\u5217\u51FA\u672C\u673A\u5B9E\u9645\u652F\u6301\u7684 PDF \u8F6C\u6362\u3001\u8BC6\u522B\u3001\u62C6\u5206\u5408\u5E76\u3001\u538B\u7F29\u3001\u6C34\u5370\u548C\u52A0\u5BC6\u547D\u4EE4\u3002\u4E0D\u4F1A\u8BFB\u53D6\u7528\u6237\u6587\u6863\u3002",
    inputSchema: emptySchema,
    execute: async () => guarded(ctx, { action: "status" })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_help",
    description: "\u8BFB\u53D6\u672C\u673A WPS \u67D0\u9879\u547D\u4EE4\u7684\u771F\u5B9E\u53C2\u6570\u3001\u4F1A\u5458\u8981\u6C42\u548C\u9650\u5236\u8BF4\u660E\u3002\u6267\u884C\u524D\u53EF\u5148\u67E5\u770B\uFF0C\u5C24\u5176\u662F\u626B\u63CF\u4EF6\u8BC6\u522B\u548C\u52A0\u5BC6\u3002",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: { command: { type: "string", enum: [...COMMANDS, "pdfinfo"] } }
    },
    execute: async (args = {}) => guarded(ctx, { action: "help", command: args.command })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_pdf_info",
    description: "\u53EA\u8BFB\u67E5\u8BE2\u672C\u673A PDF \u7684\u9875\u6570\u4E0E\u626B\u63CF\u4EF6\u8BC6\u522B\u7ED3\u679C\u3002input \u662F\u672C\u673A PDF \u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u53D7\u5BC6\u7801\u4FDD\u62A4\u65F6\u53EF\u4F20 options.password\u3002",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: {
        input: { type: "string", description: "\u672C\u673A PDF \u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84" },
        options: { type: "object", description: "\u53EF\u9009\uFF1Apassword \u4E3A PDF \u6253\u5F00\u5BC6\u7801", additionalProperties: { type: "string" } }
      }
    },
    execute: async (args = {}) => guarded(ctx, { action: "info", command: "pdfinfo", input: args.input, options: args.options ?? {} })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_read_pdf",
    description: "\u76F4\u63A5\u628A\u672C\u673A PDF \u7684\u6587\u5B57\u8FD4\u56DE\u7ED9\u5F53\u524D\u5BF9\u8BDD\uFF0C\u7528\u4E8E\u540E\u7EED\u5206\u6790\u6216\u8D77\u8349\uFF1B\u666E\u901A\u6587\u5B57 PDF \u7528 WPS \u63D0\u53D6\uFF0C\u626B\u63CF\u4EF6\u7528 WPS \u5728\u7EBF OCR \u8BC6\u522B\u540E\u8BFB\u53D6\u7ED3\u679C\uFF0C\u4E0D\u9700\u8981\u7528\u6237\u624B\u5DE5\u6253\u5F00\u8F6C\u6362\u6587\u4EF6\u3002\u6DF7\u5408 PDF \u4E2D\u56FE\u7247\u6587\u5B57\u672A\u88AB\u63D0\u53D6\u65F6\u53EF\u5728\u540C\u610F\u5728\u7EBF\u8BC6\u522B\u540E\u4F20 forceOcr=true\u3002\u957F\u6587\u6863\u6309 offset/limit \u8FDE\u7EED\u8BFB\u53D6\u3002\u5728\u7EBF OCR \u53EF\u80FD\u628A\u6307\u5B9A PDF \u5185\u5BB9\u4EA4\u7ED9 WPS\uFF0C\u53EA\u6709\u5F8B\u5E08\u660E\u786E\u540C\u610F\u672C\u6B21\u6587\u4EF6\u5728\u7EBF\u8BC6\u522B\u65F6\u624D\u80FD\u4F20 confirmOnlineOcr=true\uFF1B\u672A\u540C\u610F\u65F6\u626B\u63CF\u4EF6\u4F1A\u5B89\u5168\u62D2\u7EDD\u3002\u53EA\u4F7F\u7528\u79C1\u6709\u4E34\u65F6\u6587\u4EF6\uFF0C\u4E0D\u6539\u539F\u4EF6\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["input"], properties: {
      input: { type: "string", description: "\u672C\u673A PDF \u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84" },
      offset: { type: "integer", minimum: 0, description: "\u6587\u5B57\u8D77\u59CB\u504F\u79FB\uFF0C\u9ED8\u8BA4 0" },
      limit: { type: "integer", minimum: 1, maximum: 12e3, description: "\u672C\u6B21\u6700\u591A\u8FD4\u56DE\u5B57\u6570\uFF0C\u9ED8\u8BA4 12000" },
      forceOcr: { type: "boolean", description: "\u6DF7\u5408 PDF \u9700\u8981\u8BFB\u53D6\u56FE\u7247\u91CC\u7684\u5B57\u65F6\u8BBE true\uFF1B\u4ECD\u9700\u5148\u83B7\u5F97\u5728\u7EBF OCR \u540C\u610F" },
      confirmOnlineOcr: { type: "boolean", description: "\u4EC5\u5728\u5F8B\u5E08\u660E\u786E\u540C\u610F\u5C06\u672C\u6587\u4EF6\u4EA4\u7ED9 WPS \u5728\u7EBF OCR \u65F6\u4E3A true" }
    } },
    execute: async (args = {}) => guarded(ctx, {
      action: "read_pdf",
      input: args.input,
      offset: args.offset,
      limit: args.limit,
      forceOcr: args.forceOcr,
      confirmOnlineOcr: args.confirmOnlineOcr
    })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_run",
    description: "\u7528\u672C\u673A WPS \u6267\u884C PDF\u2194Word/Excel/PPT\u3001\u56FE\u7247\u8F6C PDF\u3001PDF \u62C6\u5206\u5408\u5E76\u3001\u538B\u7F29\u3001\u6C34\u5370\u548C\u52A0\u5BC6\uFF1B\u82E5\u53EA\u9700\u628A PDF \u6216\u626B\u63CF PDF \u7684\u6587\u5B57\u76F4\u63A5\u7ED9\u5F53\u524D\u5BF9\u8BDD\uFF0C\u4F18\u5148\u4F7F\u7528 wps_read_pdf\uFF1B\u9700\u8981\u53EF\u7F16\u8F91 Word \u4EA7\u7269\u624D\u4F7F\u7528 wps_ocr\u3002\u5FC5\u987B\u7531\u5F8B\u5E08\u5728\u672C\u8F6E\u5BF9\u8BDD\u4E2D\u660E\u786E\u8981\u6C42\u6216\u786E\u8BA4\u5177\u4F53\u64CD\u4F5C\u540E\u624D\u53EF\u8BBE confirm=true\uFF1B\u7ED3\u679C\u5FC5\u987B\u5199\u5230\u65B0\u7684\u8F93\u51FA\u6587\u4EF6\u6216\u76EE\u5F55\uFF0C\u4E0D\u8986\u76D6\u539F\u4EF6\u3002\u5148\u7528 wps_help \u67E5\u770B\u5BF9\u5E94\u547D\u4EE4\u7684\u9009\u9879\u3002output \u662F\u7528\u6237\u8BF7\u6C42\u8DEF\u5F84\uFF0CcanonicalOutput \u662F\u540C\u4E00\u6587\u4EF6\u7684\u89C4\u8303\u5316\u8DEF\u5F84\uFF0C\u4E0D\u8981\u628A\u4E24\u8005\u8BF4\u6210\u4E0D\u540C\u6587\u4EF6\u3002\u4F1A\u5458\u6743\u76CA\u3001\u4E91\u7AEF\u8BC6\u522B\u548C\u6587\u4EF6\u5185\u5BB9\u662F\u5426\u4E0A\u4F20\u7531 WPS \u547D\u4EE4\u81EA\u8EAB\u51B3\u5B9A\u3002",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["command", "inputs", "output", "confirm"],
      properties: {
        command: { type: "string", enum: [...COMMANDS], description: "WPS \u547D\u4EE4\uFF1B\u5148\u901A\u8FC7 wps_help \u67E5\u770B\u8BE6\u60C5" },
        inputs: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" }, description: "\u672C\u673A\u8F93\u5165\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6700\u591A 20 \u4E2A" },
        output: { type: "string", description: "\u65B0\u7684\u8F93\u51FA\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u62C6\u5206\u3001\u591A\u6587\u4EF6\u6279\u5904\u7406\u548C\u591A\u5F20\u56FE\u7247\u8F93\u51FA\u65F6\u4F7F\u7528\u5DF2\u5B58\u5728\u7684\u76EE\u5F55" },
        options: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "WPS \u547D\u4EE4\u9009\u9879\uFF1B\u952E\u540D\u4E0D\u5E26 --\uFF0C\u5982 range\u3001scanned\u3001ai-fix\u3001press-quality\u3001text\u3001open-pwd" },
        confirm: { type: "boolean", description: "\u4EC5\u5F53\u5F8B\u5E08\u5DF2\u660E\u786E\u8981\u6C42\u6216\u786E\u8BA4\u672C\u6B21\u5199\u51FA\u64CD\u4F5C\u65F6\u4E3A true" }
      }
    },
    execute: async (args = {}) => guarded(ctx, { action: "run", command: args.command, inputs: args.inputs, output: args.output, options: args.options ?? {}, confirm: args.confirm })
  }));
  const hostSchema = { type: "string", enum: ["word", "spreadsheet", "presentation"], description: "\u6587\u5B57\u3001\u8868\u683C\u6216\u6F14\u793A" };
  dispose.push(ctx.tools.register({
    name: "wps_ocr",
    description: "\u7528\u672C\u673A WPS \u4F1A\u5458\u5BF9\u56FE\u7247\u578B PDF\u3001PNG \u6216 JPG \u505A\u5728\u7EBF OCR\u3002\u53EA\u9700\u628A\u56FE\u7247\u6587\u5B57\u76F4\u63A5\u7528\u4E8E\u5F53\u524D\u5BF9\u8BDD\u65F6\uFF0C\u4E0D\u4F20 output\uFF0CWPS \u81EA\u52A8\u628A\u56FE\u7247\u8F6C\u4E3A\u4E34\u65F6 PDF\u3001\u8BC6\u522B\u5E76\u76F4\u63A5\u8FD4\u56DE\u6587\u5B57\uFF0C\u4E0D\u7559\u4E0B\u7528\u6237\u6587\u4EF6\uFF1B\u957F\u6587\u5B57\u53EF\u7528 offset/limit \u5206\u9875\u3002\u7528\u6237\u8981\u6C42\u65B0\u7684\u53EF\u7F16\u8F91 Word \u65F6\u624D\u4F20 output\uFF0C\u4EA4\u4ED8 DOCX \u4E14\u4E0D\u8986\u76D6\u539F\u4EF6\u3002PDF \u6587\u5B57\u76F4\u8FD4\u4F18\u5148\u4F7F\u7528 wps_read_pdf\u3002WPS \u5728\u7EBF OCR \u53EF\u80FD\u4E0A\u4F20\u6307\u5B9A\u8F93\u5165\u5185\u5BB9\uFF0C\u53EA\u6709\u5F8B\u5E08\u5DF2\u660E\u786E\u540C\u610F\u672C\u6B21\u6587\u4EF6\u4EA4\u7ED9 WPS \u5728\u7EBF\u8BC6\u522B\u65F6\u624D\u80FD\u8BBE confirm=true\u3002\u7ED3\u679C output \u662F\u7528\u6237\u8BF7\u6C42\u8DEF\u5F84\uFF0CcanonicalOutput \u662F\u540C\u4E00\u6587\u4EF6\u7684\u89C4\u8303\u5316\u8DEF\u5F84\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["input", "confirm"], properties: {
      input: { type: "string", description: "\u672C\u673A PDF\u3001PNG\u3001JPG \u6216 JPEG \u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84" },
      output: { type: "string", description: "\u4EC5\u9700\u4EA4\u4ED8\u53EF\u7F16\u8F91 Word \u65F6\u586B\u5199\u65B0\u7684 .docx \u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u53EA\u9700\u76F4\u63A5\u56DE\u7B54\u8BC6\u522B\u6587\u5B57\u65F6\u4E0D\u4F20" },
      offset: { type: "integer", minimum: 0, description: "\u4E0D\u4F20 output \u65F6\u7684\u6587\u5B57\u8D77\u59CB\u504F\u79FB\uFF0C\u9ED8\u8BA4 0" },
      limit: { type: "integer", minimum: 1, maximum: 12e3, description: "\u4E0D\u4F20 output \u65F6\u672C\u6B21\u6700\u591A\u8FD4\u56DE\u5B57\u6570\uFF0C\u9ED8\u8BA4 12000" },
      aiFix: { type: "boolean", description: "\u53EF\u9009\uFF1A\u542F\u7528 WPS \u5728\u7EBF AI \u4FEE\u590D\u626B\u63CF\u7248\u5F0F\uFF0C\u9ED8\u8BA4 false" },
      confirm: { type: "boolean", description: "\u5F8B\u5E08\u5DF2\u540C\u610F WPS \u5728\u7EBF OCR \u5904\u7406\u672C\u6587\u4EF6\uFF1B\u5199\u51FA DOCX \u65F6\u8FD8\u987B\u786E\u8BA4\u65B0\u6587\u4EF6\u5199\u51FA" }
    } },
    execute: async (args = {}) => {
      if (typeof args.output === "string" && args.output.trim() !== "") return guarded(ctx, {
        action: "ocr",
        input: args.input,
        output: args.output,
        aiFix: args.aiFix,
        confirm: args.confirm
      });
      const pdf = typeof args.input === "string" && /\.pdf$/i.test(args.input);
      return guarded(ctx, {
        action: pdf ? "read_pdf" : "read_image",
        input: args.input,
        forceOcr: pdf,
        confirmOnlineOcr: args.confirm,
        offset: args.offset,
        limit: args.limit
      });
    }
  }));
  dispose.push(ctx.tools.register({
    name: "wps_connection",
    description: "\u53EA\u8BFB\u68C0\u67E5 WPS \u6587\u5B57\u3001\u8868\u683C\u3001\u6F14\u793A\u4E09\u4E2A\u672C\u673A\u7EC4\u4EF6\u662F\u5426\u5DF2\u8FDE\u63A5\uFF0C\u4EE5\u53CA\u4E0A\u6B21\u5199\u5165\u662F\u5426\u5B58\u5728\u5F85\u6838\u67E5\u72B6\u6001\u3002\u6682\u65F6\u6CA1\u6709\u8FDE\u63A5\u53EF\u5148\u7528 wps_open_document \u81EA\u52A8\u6253\u5F00\u6587\u4EF6\u3002",
    inputSchema: emptySchema,
    execute: async () => bridge({ action: "status" })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_acknowledge_uncertain",
    description: "\u4EC5\u5F53 LawyerCopilot \u62A5\u544A WPS \u5199\u5165\u7ED3\u679C\u672A\u77E5\uFF0C\u4E14\u5F8B\u5E08\u5DF2\u5728 WPS \u4E2D\u4EBA\u5DE5\u68C0\u67E5\u76F8\u5173\u6587\u6863\u5E76\u5728\u672C\u8F6E\u5BF9\u8BDD\u660E\u786E\u8868\u793A\u5DF2\u6838\u67E5\u540E\uFF0C\u89E3\u9664\u540E\u7EED\u5199\u5165\u6682\u505C\u3002\u4E0D\u5F97\u4E3A\u4E86\u7EE7\u7EED\u4EFB\u52A1\u800C\u81EA\u884C\u8C03\u7528\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["checked"], properties: {
      checked: { type: "boolean", description: "\u5F8B\u5E08\u5DF2\u5728 WPS \u4EBA\u5DE5\u6838\u67E5\u5E76\u660E\u786E\u786E\u8BA4\u65F6\u624D\u53EF\u4E3A true" }
    } },
    execute: async (args = {}) => bridge({ action: "acknowledge", checked: args.checked })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_open_document",
    description: "\u5C06\u6307\u5B9A\u672C\u673A Word\u3001Excel \u6216 PowerPoint \u6587\u4EF6\u4EA4\u7ED9 WPS \u6253\u5F00\uFF0C\u5E76\u7B49\u5230 WPS \u8BFB\u56DE\u786E\u8BA4\u3002\u65E0\u9700\u7528\u6237\u63D0\u524D\u624B\u52A8\u6253\u5F00\uFF1B\u4EC5\u6253\u5F00\uFF0C\u4E0D\u4FEE\u6539\u6587\u4EF6\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", description: "\u672C\u673A\u6587\u6863\u7EDD\u5BF9\u8DEF\u5F84" }
    } },
    execute: async (args = {}) => bridge({ action: "open_document", params: { path: args.path } })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_documents",
    description: "\u5217\u51FA\u5F53\u524D WPS \u6587\u5B57\u3001\u8868\u683C\u6216\u6F14\u793A\u4E2D\u5DF2\u6253\u5F00\u7684\u6587\u6863\uFF0C\u4E0D\u8BFB\u53D6\u6B63\u6587\u3002\u6CA1\u6709\u5DF2\u8FDE\u63A5\u7EC4\u4EF6\u65F6\uFF0C\u53EF\u5148\u7528 wps_open_document \u81EA\u52A8\u6253\u5F00\u672C\u673A\u6587\u4EF6\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["host"], properties: { host: hostSchema } },
    execute: async (args = {}) => bridge({ host: args.host, action: "list", params: {} })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_inspect",
    description: '\u53EA\u8BFB\u68C0\u67E5 WPS \u5DF2\u6253\u5F00\u6587\u6863\u7684\u672C\u673A\u5BF9\u8C61\u5C5E\u6027\uFF0C\u53EF\u8BFB\u53D6\u6BB5\u843D\u3001\u8868\u683C\u3001\u5DE5\u4F5C\u8868\u3001\u5E7B\u706F\u7247\u53CA\u5176\u5F62\u72B6\u7B49 WPS \u81EA\u8EAB\u63D0\u4F9B\u7684\u6570\u636E\u3002members \u4ECE\u6587\u6863\u5BF9\u8C61\u5F00\u59CB\uFF0C\u7528\u82F1\u6587\u5C5E\u6027\u540D\u6216 1 \u8D77\u59CB\u7684\u96C6\u5408\u5E8F\u53F7\uFF1B\u4F8B\u5982 ["Slides",1,"Shapes",1,"TextFrame","TextRange","Text"]\u3002Font.Bold/Italic \u7684 enabled \u5B57\u6BB5\u8868\u793A\u5F00\u5173\u72B6\u6001\uFF0CWPS -1 \u662F\u542F\u7528\u30010 \u662F\u5173\u95ED\u3002\u6BCF\u6B21\u6700\u591A 12 \u6B65\uFF0C\u4E0D\u6267\u884C\u5B8F\u6216\u4FEE\u6539\u3002\u8868\u683C\u5355\u5143\u683C\u7684\u539F\u59CB\u516C\u5F0F\u9700\u8981\u8C03\u7528 Range("C1") \u65B9\u6CD5\uFF0C\u4E0D\u80FD\u7528\u672C\u5DE5\u5177\u7684\u5C5E\u6027\u8DEF\u5F84\u8868\u793A\uFF1B\u8BFB\u53D6\u516C\u5F0F\u8BF7\u7528 wps_native_api \u7684 op=call Range \u540E get Formula\u3002\u6587\u6863\u672A\u6253\u5F00\u65F6\u81EA\u52A8\u6253\u5F00\u5E76\u91CD\u8BD5\u4E00\u6B21\u3002',
    inputSchema: { type: "object", additionalProperties: false, required: ["host", "path", "members"], properties: {
      host: hostSchema,
      path: { type: "string" },
      members: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: { type: ["string", "integer"] },
        description: "\u4ECE\u8BE5\u6587\u6863\u5F00\u59CB\u9010\u5C42\u8BFB\u53D6\u7684\u82F1\u6587\u5C5E\u6027\u540D\u6216 1 \u8D77\u59CB\u96C6\u5408\u5E8F\u53F7"
      }
    } },
    execute: async (args = {}) => readOpenedDocument(String(args.host), "inspect", { path: args.path, members: args.members })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_native_api",
    description: '\u901A\u8FC7\u672C\u673A WPS \u6587\u6863\u5BF9\u8C61\u63A5\u53E3\u6267\u884C\u53D7\u63A7\u7684\u5C5E\u6027\u8BFB\u53D6\u6216\u7F16\u8F91\uFF0C\u5728\u5DF2\u5141\u8BB8\u7684\u5BF9\u8C61\u4E0E\u65B9\u6CD5\u8303\u56F4\u5185\u9002\u7528\u4E8E\u4E13\u7528\u5DE5\u5177\u6CA1\u6709\u8986\u76D6\u7684\u80FD\u529B\uFF1Bread \u6A21\u5F0F\u5728\u6587\u6863\u672A\u6253\u5F00\u6216\u7EC4\u4EF6\u672A\u8FDE\u63A5\u65F6\u4F1A\u81EA\u52A8\u6253\u5F00\u672C\u673A\u6587\u4EF6\u5E76\u91CD\u8BD5\u4E00\u6B21\u3002\u6B65\u9AA4\u4ECE document \u5F00\u59CB\uFF0C\u524D\u4E00\u6B65\u7ED3\u679C\u53EF\u6309 0 \u8D77\u59CB\u7F16\u53F7\u5F15\u7528\uFF1Aget \u53EA\u8BFB\u53D6\u6570\u636E\u5C5E\u6027\uFF1Bitem \u9009\u96C6\u5408\u9879\uFF1B\u65B9\u6CD5\u5FC5\u987B\u7528 op=call \u5E76\u63D0\u4F9B args\uFF0C\u4E0D\u80FD\u7528 get \u8BFB\u53D6\u65B9\u6CD5\uFF1Bset \u4FEE\u6539\u5141\u8BB8\u7684\u5C5E\u6027\uFF1Bread \u6A21\u5F0F\u53EF\u628A op=probe \u653E\u5728\u6700\u540E\u4E00\u6B65\uFF0C\u67E5\u8BE2\u5019\u9009\u6210\u5458\u662F\u5426\u4E3A\u65B9\u6CD5\u53CA\u5F53\u524D\u53C2\u6570\u662F\u5426\u5141\u8BB8\u8C03\u7528\uFF0Cprobe \u4E0D\u6267\u884C\u65B9\u6CD5\u6216\u4FEE\u6539\u3002\u793A\u4F8B\uFF1A\u8BFB\u53D6 Excel \u7684 Sheet1!C1 \u539F\u59CB\u516C\u5F0F\u548C\u8BA1\u7B97\u503C\uFF0C\u4F9D\u6B21\u6267\u884C get Worksheets\u3001item index="Sheet1" from=0\u3001op=call member=Range args=["C1"] from=1\u3001get Formula from=2\u3001get Value2 from=2\u3002\u5355\u4E2A\u5355\u5143\u683C\u53EF\u5148 get Formula \u518D set Formula \u5199\u5165\u672C\u5730\u7B97\u672F\u516C\u5F0F\uFF08\u4F8B\u5982 =A1+B1\uFF09\uFF0C\u9700\u660E\u786E\u4FEE\u6539\u8BF7\u6C42\u4E0E confirm=true\uFF1B\u53EA\u5141\u8BB8\u9650\u5B9A\u7684\u786E\u5B9A\u6027\u6570\u503C\u51FD\u6570\uFF0C\u4E0D\u5141\u8BB8\u5916\u90E8\u5DE5\u4F5C\u7C3F\u3001URL\u3001\u5B8F\u3001\u7F51\u7EDC\u6216\u53EF\u80FD\u5411\u591A\u683C\u6EA2\u51FA\u7684\u8868\u8FBE\u5F0F\u3002Word PageSetup \u7684 LeftMargin/RightMargin/TopMargin/BottomMargin \u5355\u4F4D\u4E3A\u78C5\uFF0C\u53EF\u8BBE 0 \u81F3 360\uFF1BOrientation \u53EF\u8BBE 0 \u7EB5\u5411\u6216 1 \u6A2A\u5411\u3002read \u6A21\u5F0F\u5141\u8BB8 get/item/\u5DF2\u5141\u8BB8\u7684\u53EA\u8BFB call\uFF1Bedit \u6A21\u5F0F\u9700\u8981\u5F8B\u5E08\u5728\u672C\u8F6E\u660E\u786E\u540C\u610F\u5E76\u4F20 confirm=true\u3002set \u53EF\u586B\u521A\u8BFB\u5230\u7684 expectedValue\uFF0C\u4E5F\u53EF\u5728\u540C\u4E00 steps \u4E2D\u5148 get \u540C\u4E00\u5C5E\u6027\u518D set\uFF0C\u63D2\u4EF6\u81EA\u52A8\u7528\u8BE5\u65E7\u503C\u6821\u9A8C\uFF1B\u6587\u5B57\u7F16\u8F91\u8FD8\u9700\u5148\u7528 wps_read_word \u53D6\u5F97 version\u3002Font.Bold/Italic \u7ED3\u679C\u91CC\u7684 enabled \u4E3A\u660E\u786E\u7684\u5F00\u5173\u72B6\u6001\uFF1AWPS \u6570\u503C -1 \u8868\u793A\u542F\u7528\u30010 \u8868\u793A\u5173\u95ED\u3002\u7F16\u8F91\u7559\u5728 WPS \u5185\uFF0C\u4FDD\u5B58\u9700\u53E6\u7528 wps_save_document\u3002\u82E5\u8FD4\u56DE\u5199\u5165\u7ED3\u679C\u672A\u77E5\uFF0C\u5148\u5728 WPS \u6838\u5BF9\uFF0C\u4E0D\u5F97\u81EA\u52A8\u91CD\u8BD5\u3002',
    inputSchema: { type: "object", additionalProperties: false, required: ["host", "path", "mode", "steps"], properties: {
      host: hostSchema,
      path: { type: "string" },
      mode: { type: "string", enum: ["read", "edit"] },
      expectedVersion: { type: "string", description: "\u6587\u5B57\u6587\u6863 edit \u65F6\u5FC5\u586B\uFF1A\u6765\u81EA wps_read_word \u7684 version" },
      steps: { type: "array", minItems: 1, maxItems: 20, items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "from"],
        properties: {
          op: { type: "string", enum: ["get", "item", "set", "call", "probe"], description: 'get=\u8BFB\u53D6\u6570\u636E\u5C5E\u6027\uFF1Bitem=\u9009\u62E9\u96C6\u5408\u9879\uFF1Bcall=\u8C03\u7528\u5DF2\u5141\u8BB8\u7684\u65B9\u6CD5\uFF1Bset=\u4FEE\u6539\u5DF2\u5141\u8BB8\u7684\u5C5E\u6027\uFF1Bprobe=\u53EA\u8BFB\u63A2\u6D4B\u6700\u540E\u4E00\u6B65\u7684\u6210\u5458\u7C7B\u578B\u548C\u8BB8\u53EF\uFF0C\u4E0D\u6267\u884C\u65B9\u6CD5\u3002WPS Range("C1") \u662F\u65B9\u6CD5\uFF0C\u5E94\u4F7F\u7528 call' },
          from: { type: ["string", "integer"], description: "document \u6216\u6B64\u524D\u6B65\u9AA4\u7684 0 \u8D77\u59CB\u7F16\u53F7" },
          member: { type: "string", description: "WPS \u5B98\u65B9\u5BF9\u8C61\u5C5E\u6027\u6216\u65B9\u6CD5\u540D\uFF1B\u65B9\u6CD5\u5982 Range \u5FC5\u987B\u914D\u5408 op=call\uFF0C\u4E0D\u80FD\u7528 get" },
          index: { type: ["integer", "string"], description: "\u96C6\u5408\u9879\u5E8F\u53F7\uFF1B\u8868\u683C Worksheets \u4E5F\u53EF\u586B\u5DE5\u4F5C\u8868\u540D\u79F0" },
          value: { type: ["string", "number", "boolean"], description: "set \u7684\u65B0\u503C" },
          expectedValue: { type: ["string", "number", "boolean", "null"], description: "set \u53EF\u586B\u521A\u8BFB\u5230\u7684\u65E7\u503C\uFF1B\u82E5\u540C\u4E00 steps \u5DF2\u5148 get \u540C\u4E00\u5C5E\u6027\uFF0C\u5219\u53EF\u7701\u7565" },
          args: { type: "array", maxItems: 8, description: 'call \u7684\u65B9\u6CD5\u53C2\u6570\u6216 probe \u7684\u62DF\u8BAE\u53C2\u6570\uFF0C\u5982 Range("C1") \u4F20 ["C1"]\uFF1B\u53EF\u7528 {ref: \u6B65\u9AA4\u7F16\u53F7} \u5F15\u7528\u6B64\u524D WPS \u5BF9\u8C61' }
        }
      } },
      confirm: { type: "boolean", description: "edit \u65F6\u4EC5\u5728\u5F8B\u5E08\u786E\u8BA4\u5177\u4F53\u4FEE\u6539\u540E\u4E3A true" }
    } },
    execute: async (args = {}) => {
      if (args.mode !== "read" && args.mode !== "edit") return result("WPS \u539F\u751F\u64CD\u4F5C\u6A21\u5F0F\u65E0\u6548", true);
      if (args.mode === "read") return readOpenedDocument(String(args.host), "api_read", { path: args.path, steps: args.steps });
      return bridge({
        host: args.host,
        action: "api_edit",
        params: { path: args.path, steps: args.steps, expectedVersion: args.expectedVersion },
        confirm: args.confirm
      });
    }
  }));
  dispose.push(ctx.tools.register({
    name: "wps_read_word",
    description: "\u5206\u6BB5\u8BFB\u53D6\u672C\u673A Word \u6587\u6863\u6B63\u6587\uFF1B\u6587\u4EF6\u5C1A\u672A\u5728 WPS \u4E2D\u6253\u5F00\u65F6\u4F1A\u81EA\u52A8\u6253\u5F00\u3002\u957F\u6587\u6863\u53EF\u6309 offset \u8FDE\u7EED\u8BFB\u53D6\u3002\u8FD4\u56DE tableCount\uFF1B\u82E5\u5927\u4E8E 0\uFF0C\u5E94\u7EE7\u7EED\u7528 wps_read_word_table \u5206\u9875\u8BFB\u53D6\u8868\u683C\u5355\u5143\u683C\uFF0C\u907F\u514D\u53EA\u770B\u6B63\u6587\u9057\u6F0F\u8868\u683C\u8BC1\u636E\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 12e3 }
    } },
    execute: async (args = {}) => readOpenedDocument("word", "read_word", args)
  }));
  dispose.push(ctx.tools.register({
    name: "wps_read_word_table",
    description: "\u8BFB\u53D6\u672C\u673A Word \u8868\u683C\u5185\u5BB9\uFF0C\u6587\u4EF6\u5C1A\u672A\u5728 WPS \u4E2D\u6253\u5F00\u65F6\u4F1A\u81EA\u52A8\u6253\u5F00\uFF1A\u4EE5 1 \u8D77\u59CB\u7F16\u53F7\u6307\u5B9A\u8868\u683C\uFF0C\u6309\u884C\u5217\u504F\u79FB\u5206\u6BB5\u8BFB\u53D6\uFF0C\u6700\u591A\u4E00\u6B21 20 \u884C\u548C 10 \u5217\u3002\u8FD4\u56DE\u603B\u884C\u5217\u6570\u3001\u5355\u5143\u683C\u6587\u5B57\u4E0E\u6587\u6863 version\uFF1B\u4E0D\u4F1A\u4FEE\u6539\u6587\u4EF6\u3002\u957F\u8868\u683C\u7EE7\u7EED\u4F20 rowOffset/columnOffset \u5206\u9875\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "table"], properties: {
      path: { type: "string", description: "\u5DF2\u5728 WPS \u6587\u5B57\u6253\u5F00\u7684\u6587\u6863\u7EDD\u5BF9\u8DEF\u5F84" },
      table: { type: "integer", minimum: 1, description: "\u8868\u683C\u5E8F\u53F7\uFF0C\u4ECE 1 \u5F00\u59CB" },
      rowOffset: { type: "integer", minimum: 0, description: "\u4ECE\u7B2C\u51E0\u884C\u4E4B\u540E\u5F00\u59CB\u8BFB\uFF0C\u9ED8\u8BA4 0" },
      rowLimit: { type: "integer", minimum: 1, maximum: 20, description: "\u672C\u6B21\u6700\u591A\u8BFB\u53D6\u884C\u6570\uFF0C\u9ED8\u8BA4 20" },
      columnOffset: { type: "integer", minimum: 0, description: "\u4ECE\u7B2C\u51E0\u5217\u4E4B\u540E\u5F00\u59CB\u8BFB\uFF0C\u9ED8\u8BA4 0" },
      columnLimit: { type: "integer", minimum: 1, maximum: 10, description: "\u672C\u6B21\u6700\u591A\u8BFB\u53D6\u5217\u6570\uFF0C\u9ED8\u8BA4 10" }
    } },
    execute: async (args = {}) => readOpenedDocument("word", "read_word_table", args)
  }));
  dispose.push(ctx.tools.register({
    name: "wps_replace_word",
    description: "\u5728 WPS \u6587\u5B57\u4E2D\u4EE5\u4FEE\u8BA2\u6A21\u5F0F\u66FF\u6362\u552F\u4E00\u7684\u4E00\u6BB5\u539F\u6587\uFF0C\u4FEE\u6539\u540E\u7559\u5728 WPS \u4E2D\u7B49\u5F85\u7528\u6237\u67E5\u770B\uFF0C\u4E0D\u81EA\u52A8\u4FDD\u5B58\u3002\u5FC5\u987B\u662F\u5F8B\u5E08\u5728\u672C\u8F6E\u5BF9\u8BDD\u660E\u786E\u8981\u6C42\u7684\u5177\u4F53\u4FEE\u6539\uFF1B\u5148\u8BFB\u6587\u6863\u5E76\u4F20\u5165\u8BFB\u53D6\u5F97\u5230\u7684 version\uFF0C\u6587\u6863\u53D8\u5316\u5219\u62D2\u7EDD\u5199\u5165\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "quote", "replacement", "expectedVersion", "confirm"], properties: {
      path: { type: "string" },
      quote: { type: "string", maxLength: 2e3 },
      replacement: { type: "string", maxLength: 2e3 },
      expectedVersion: { type: "string" },
      confirm: { type: "boolean", description: "\u5F8B\u5E08\u5DF2\u660E\u786E\u8981\u6C42\u672C\u6B21\u5177\u4F53\u66FF\u6362\u65F6\u4E3A true" }
    } },
    execute: async (args = {}) => bridge({ host: "word", action: "replace_word", params: args, confirm: args.confirm })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_append_word",
    description: "\u5728\u672C\u673A WPS \u6587\u5B57\u5DF2\u6253\u5F00\u6587\u6863\u7684\u672B\u5C3E\u8FFD\u52A0\u6B63\u6587\uFF0C\u542F\u7528\u4FEE\u8BA2\uFF0C\u5E76\u8BFB\u56DE\u786E\u8BA4\u3002\u5148\u7528 wps_read_word \u53D6\u5F97\u6700\u65B0 version \u540E\u586B expectedVersion\uFF1B\u5185\u5BB9\u53D8\u5316\u65F6\u62D2\u7EDD\u3002\u53EA\u6709\u5F8B\u5E08\u672C\u8F6E\u660E\u786E\u8981\u6C42\u8FFD\u52A0\u8FD9\u6BB5\u5185\u5BB9\u65F6 confirm=true\u3002\u82E5\u5F8B\u5E08\u540C\u65F6\u660E\u786E\u8981\u6C42\u4FDD\u5B58\uFF0C\u4F20 save=true\uFF0C\u4E00\u6B21\u5DE5\u5177\u8C03\u7528\u4F1A\u5728\u8FFD\u52A0\u6210\u529F\u540E\u7ACB\u5373\u4FDD\u5B58\uFF1B\u5426\u5219\u4FEE\u6539\u7559\u5728 WPS \u4E2D\uFF0C\u53EF\u53E6\u8C03\u7528 wps_save_document\u3002",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "text", "expectedVersion", "confirm"],
      properties: {
        path: { type: "string", description: "\u5DF2\u5728 WPS \u6587\u5B57\u4E2D\u6253\u5F00\u7684\u6587\u6863\u7EDD\u5BF9\u8DEF\u5F84" },
        text: { type: "string", minLength: 1, maxLength: 12e3, description: "\u8981\u8FFD\u52A0\u7684\u6B63\u6587\uFF0C\u53EF\u5305\u542B\u6362\u884C" },
        expectedVersion: { type: "string", description: "\u521A\u4ECE wps_read_word \u83B7\u53D6\u7684 version" },
        confirm: { type: "boolean", description: "\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u8FD9\u6B21\u8FFD\u52A0\u6B63\u6587\u65F6\u4E3A true" },
        save: { type: "boolean", description: "\u4EC5\u5728\u5F8B\u5E08\u540C\u65F6\u660E\u786E\u8981\u6C42\u4FDD\u5B58\u6B64\u6587\u4EF6\u65F6\u4E3A true\uFF1B\u8FFD\u52A0\u6210\u529F\u540E\u7ACB\u5373\u4FDD\u5B58\uFF0C\u9ED8\u8BA4\u4E0D\u4FDD\u5B58" }
      }
    },
    execute: async (args = {}) => {
      const { save: saveRequested, ...appendParams } = args;
      const appended = await bridge({ host: "word", action: "append_word", params: appendParams, confirm: args.confirm });
      if (appended.isError || saveRequested !== true) return appended;
      const saved = await bridge({ host: "word", action: "save", params: { path: args.path }, confirm: args.confirm });
      if (saved.isError) return result(`\u8FFD\u52A0\u5DF2\u5728 WPS \u751F\u6548\uFF0C\u4F46\u672A\u80FD\u786E\u8BA4\u4FDD\u5B58\uFF1A${saved.content[0].text}\u3002\u8BF7\u5728 WPS \u6838\u67E5\u5E76\u4FDD\u5B58\uFF0C\u4E0D\u8981\u91CD\u65B0\u8FFD\u52A0\u3002`, true);
      try {
        const appendValue = JSON.parse(appended.content[0].text);
        const saveValue = JSON.parse(saved.content[0].text);
        if (saveValue.saved !== true) throw new Error("WPS \u672A\u786E\u8BA4\u4FDD\u5B58\u6210\u529F");
        return result(JSON.stringify({ ...appendValue, saved: true }, null, 2));
      } catch {
        return result("\u8FFD\u52A0\u5DF2\u5728 WPS \u751F\u6548\uFF0C\u4F46\u4FDD\u5B58\u56DE\u6267\u65E0\u6CD5\u786E\u8BA4\uFF1B\u8BF7\u5728 WPS \u6838\u67E5\uFF0C\u4E0D\u8981\u91CD\u65B0\u8FFD\u52A0\u3002", true);
      }
    }
  }));
  dispose.push(ctx.tools.register({
    name: "wps_insert_table",
    description: "\u5728 WPS \u6587\u5B57\u5DF2\u6253\u5F00\u6587\u6863\u672B\u5C3E\u63D2\u5165\u8868\u683C\uFF0C\u542F\u7528\u4FEE\u8BA2\u5E76\u5C06\u6587\u5B57\u5199\u5165\u5355\u5143\u683C\u3002\u5148\u7528 wps_read_word \u8BFB\u53D6\u5F53\u524D version\uFF0C\u4F20 expectedVersion\uFF1B\u63D2\u5165\u540E\u7559\u5728 WPS \u4F9B\u5F8B\u5E08\u67E5\u770B\uFF0C\u53EA\u6709\u660E\u786E\u8981\u6C42\u4FDD\u5B58\u65F6\u624D\u53E6\u7528 wps_save_document\u3002\u4EC5\u5728\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u672C\u6B21\u5177\u4F53\u63D2\u5165\u65F6 confirm=true\u3002",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "expectedVersion", "rows", "confirm"],
      properties: {
        path: { type: "string", description: "\u5DF2\u5728 WPS \u6587\u5B57\u6253\u5F00\u7684\u6587\u6863\u7EDD\u5BF9\u8DEF\u5F84" },
        expectedVersion: { type: "string", description: "\u521A\u4ECE wps_read_word \u83B7\u53D6\u7684 version" },
        rows: { type: "array", minItems: 1, maxItems: 20, description: "\u77E9\u5F62\u8868\u683C\uFF0C\u6700\u591A 20 \u884C 10 \u5217", items: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string", maxLength: 2e3 }
        } },
        confirm: { type: "boolean", description: "\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u672C\u6B21\u63D2\u5165\u8868\u683C\u65F6\u4E3A true" }
      }
    },
    execute: async (args = {}) => bridge({ host: "word", action: "insert_table", params: args, confirm: args.confirm })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_insert_image",
    description: "\u901A\u8FC7 WPS \u529E\u516C\u52A9\u624B\u63D2\u4EF6\u628A\u672C\u673A PNG/JPG \u5D4C\u5165\u5DF2\u6253\u5F00\u7684\u6587\u5B57\u6587\u6863\u672B\u5C3E\uFF0C\u6216\u5D4C\u5165\u6F14\u793A\u7684\u6307\u5B9A\u5E7B\u706F\u7247\uFF0C\u4E0D\u94FE\u63A5\u539F\u56FE\u3002\u6587\u5B57\u5148\u7528 wps_read_word \u53D6 expectedVersion\uFF0C\u63D2\u5165\u540E\u542F\u7528\u4FEE\u8BA2\uFF1B\u6F14\u793A\u5148\u7528 wps_slides_info \u548C wps_read_slide \u53D6 expectedSlides\u3001expectedShapeCount\uFF0C\u518D\u63D0\u4F9B\u4EE5\u78C5\u4E3A\u5355\u4F4D\u7684 left/top/width/height\u3002\u4FEE\u6539\u7559\u5728 WPS \u4E2D\uFF0C\u53EA\u6709\u660E\u786E\u8981\u6C42\u4FDD\u5B58\u65F6\u53E6\u7528 wps_save_document\u3002\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u8FD9\u6B21\u63D2\u56FE\u65F6 confirm=true\u3002",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "image", "confirm"],
      properties: {
        host: { type: "string", enum: ["word", "presentation"], description: "\u6587\u5B57\u6216\u6F14\u793A\uFF1B\u7701\u7565\u65F6\u4E3A\u6587\u5B57" },
        path: { type: "string", description: "\u5DF2\u5728\u5BF9\u5E94 WPS \u7EC4\u4EF6\u6253\u5F00\u7684\u6587\u6863\u7EDD\u5BF9\u8DEF\u5F84" },
        image: { type: "string", description: "\u672C\u673A PNG \u6216 JPG \u56FE\u7247\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6700\u591A 10 MB" },
        expectedVersion: { type: "string", description: "\u6587\u5B57\u5FC5\u586B\uFF1A\u521A\u4ECE wps_read_word \u83B7\u53D6\u7684 version" },
        slide: { type: "integer", minimum: 1, description: "\u6F14\u793A\u5FC5\u586B\uFF1A\u76EE\u6807\u5E7B\u706F\u7247\u7F16\u53F7" },
        expectedSlides: { type: "integer", minimum: 1, description: "\u6F14\u793A\u5FC5\u586B\uFF1A\u521A\u4ECE wps_slides_info \u83B7\u53D6\u7684 totalSlides" },
        expectedShapeCount: { type: "integer", minimum: 0, description: "\u6F14\u793A\u5FC5\u586B\uFF1A\u521A\u4ECE wps_read_slide \u83B7\u53D6\u7684 shapeTotal" },
        left: { type: "number", minimum: 0, description: "\u6F14\u793A\u5FC5\u586B\uFF1A\u56FE\u7247\u8DDD\u5E7B\u706F\u7247\u5DE6\u4FA7\u7684\u78C5\u6570" },
        top: { type: "number", minimum: 0, description: "\u6F14\u793A\u5FC5\u586B\uFF1A\u56FE\u7247\u8DDD\u5E7B\u706F\u7247\u9876\u90E8\u7684\u78C5\u6570" },
        width: { type: "number", exclusiveMinimum: 0, description: "\u6F14\u793A\u5FC5\u586B\uFF1A\u56FE\u7247\u5BBD\u5EA6\uFF0C\u5355\u4F4D\u78C5" },
        height: { type: "number", exclusiveMinimum: 0, description: "\u6F14\u793A\u5FC5\u586B\uFF1A\u56FE\u7247\u9AD8\u5EA6\uFF0C\u5355\u4F4D\u78C5" },
        confirm: { type: "boolean", description: "\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u5728\u6B64\u6587\u6863\u63D2\u5165\u8FD9\u5F20\u56FE\u7247\u65F6\u4E3A true" }
      }
    },
    execute: async (args = {}) => {
      if (args.host !== void 0 && args.host !== "word" && args.host !== "presentation") {
        return result("WPS \u63D2\u56FE\u7EC4\u4EF6\u65E0\u6548", true);
      }
      return bridge({ host: args.host ?? "word", action: "insert_image", params: args, confirm: args.confirm });
    }
  }));
  dispose.push(ctx.tools.register({
    name: "wps_read_workbook",
    description: "\u76F4\u63A5\u8BFB\u53D6\u672C\u673A WPS \u8868\u683C\u5DE5\u4F5C\u7C3F\u7684\u5B9E\u9645\u6570\u636E\u533A\u57DF\uFF0C\u4E0D\u7528\u9884\u5148\u77E5\u9053\u5355\u5143\u683C\u5730\u5740\uFF1B\u6587\u4EF6\u5C1A\u672A\u6253\u5F00\u65F6\u4F1A\u81EA\u52A8\u6253\u5F00\u3002\u9ED8\u8BA4\u8BFB\u53D6\u6D3B\u52A8\u5DE5\u4F5C\u8868\uFF0C\u8FD4\u56DE\u5DE5\u4F5C\u8868\u540D\u79F0\u3001\u5DF2\u7528\u8303\u56F4\u548C\u6700\u591A 20 \u884C\xD710 \u5217\u7684\u5185\u5BB9\uFF1B\u53EF\u6307\u5B9A sheet\uFF0C\u5E76\u7528 rowOffset/columnOffset \u7EE7\u7EED\u5206\u9875\u3002\u53EA\u8BFB\uFF0C\u4E0D\u4FDD\u5B58\u6216\u4FEE\u6539\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: {
      path: { type: "string", description: "\u5DF2\u5728 WPS \u8868\u683C\u4E2D\u6253\u5F00\u7684\u672C\u673A\u5DE5\u4F5C\u7C3F\u7EDD\u5BF9\u8DEF\u5F84" },
      sheet: { type: "string", description: "\u5DE5\u4F5C\u8868\u540D\u79F0\uFF1B\u7701\u7565\u65F6\u8BFB\u53D6\u6D3B\u52A8\u5DE5\u4F5C\u8868" },
      rowOffset: { type: "integer", minimum: 0, description: "\u5DF2\u7528\u533A\u57DF\u4E2D\u7684\u884C\u504F\u79FB\uFF0C\u9ED8\u8BA4 0" },
      rowLimit: { type: "integer", minimum: 1, maximum: 20, description: "\u672C\u6B21\u6700\u591A\u8BFB\u53D6\u884C\u6570\uFF0C\u9ED8\u8BA4 20" },
      columnOffset: { type: "integer", minimum: 0, description: "\u5DF2\u7528\u533A\u57DF\u4E2D\u7684\u5217\u504F\u79FB\uFF0C\u9ED8\u8BA4 0" },
      columnLimit: { type: "integer", minimum: 1, maximum: 10, description: "\u672C\u6B21\u6700\u591A\u8BFB\u53D6\u5217\u6570\uFF0C\u9ED8\u8BA4 10" }
    } },
    execute: async (args = {}) => readOpenedDocument("spreadsheet", "read_workbook", args)
  }));
  dispose.push(ctx.tools.register({
    name: "wps_read_cells",
    description: "\u8BFB\u53D6\u672C\u673A WPS \u8868\u683C\u5DE5\u4F5C\u7C3F\u7684\u4E00\u4E2A\u5355\u5143\u683C\u6216\u8FDE\u7EED\u8303\u56F4\u7684\u8BA1\u7B97\u503C\uFF1B\u6587\u4EF6\u5C1A\u672A\u6253\u5F00\u65F6\u4F1A\u81EA\u52A8\u6253\u5F00\u3002\u9700\u8981\u539F\u59CB\u516C\u5F0F\u8868\u8FBE\u5F0F\u65F6\u6539\u7528 wps_native_api \u7684 op=call Range \u540E get Formula\uFF0C\u672C\u5DE5\u5177\u53EA\u8FD4\u56DE\u503C\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "address"], properties: {
      path: { type: "string" },
      sheet: { type: "string" },
      address: { type: "string", description: "\u5982 A1 \u6216 A1:C10" }
    } },
    execute: async (args = {}) => readOpenedDocument("spreadsheet", "read_cells", args)
  }));
  dispose.push(ctx.tools.register({
    name: "wps_write_cell",
    description: "\u4FEE\u6539 WPS \u8868\u683C\u4E2D\u5DF2\u6253\u5F00\u5DE5\u4F5C\u7C3F\u7684\u5355\u4E2A\u5355\u5143\u683C\uFF0C\u5E76\u8BFB\u56DE\u786E\u8BA4\uFF1B\u7559\u5728 WPS \u4E2D\u7B49\u5F85\u7528\u6237\u67E5\u770B\uFF0C\u4E0D\u81EA\u52A8\u4FDD\u5B58\u3002\u5FC5\u987B\u662F\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u7684\u5177\u4F53\u5199\u5165\uFF1B\u5148\u8BFB\u76EE\u6807\u5355\u5143\u683C\u5E76\u4F20\u5165 expectedValue \u53EF\u9632\u6B62\u8986\u76D6\u671F\u95F4\u53D1\u751F\u7684\u6539\u52A8\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "address", "value", "expectedValue", "confirm"], properties: {
      path: { type: "string" },
      sheet: { type: "string" },
      address: { type: "string", description: "\u5982 B12" },
      value: { type: ["string", "number", "boolean"] },
      expectedValue: { type: ["string", "number", "boolean", "null"] },
      confirm: { type: "boolean" }
    } },
    execute: async (args = {}) => bridge({ host: "spreadsheet", action: "write_cell", params: args, confirm: args.confirm })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_slides_info",
    description: "\u8BFB\u53D6\u672C\u673A WPS \u6F14\u793A\u6587\u4EF6\u7684\u5E7B\u706F\u7247\u6570\u91CF\uFF1B\u6587\u4EF6\u5C1A\u672A\u6253\u5F00\u65F6\u4F1A\u81EA\u52A8\u6253\u5F00\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
    execute: async (args = {}) => readOpenedDocument("presentation", "list_slides", args)
  }));
  dispose.push(ctx.tools.register({
    name: "wps_read_slide",
    description: "\u8BFB\u53D6\u672C\u673A WPS \u6F14\u793A\u4E2D\u6307\u5B9A\u5E7B\u706F\u7247\u7684\u6587\u672C\u6846\u5185\u5BB9\uFF0C\u5305\u542B\u6807\u9898\u4E0E\u6B63\u6587\uFF1B\u6587\u4EF6\u5C1A\u672A\u6253\u5F00\u65F6\u4F1A\u81EA\u52A8\u6253\u5F00\uFF0C\u53EA\u8BFB\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "slide"], properties: {
      path: { type: "string" },
      slide: { type: "integer", minimum: 1 }
    } },
    execute: async (args = {}) => readOpenedDocument("presentation", "read_slide", args)
  }));
  dispose.push(ctx.tools.register({
    name: "wps_add_slide",
    description: "\u5728 WPS \u6F14\u793A\u4E2D\u6DFB\u52A0\u4E00\u5F20\u6807\u9898\u4E0E\u6B63\u6587\u5E7B\u706F\u7247\uFF0C\u7559\u5728 WPS \u4F9B\u5F8B\u5E08\u67E5\u770B\uFF0C\u4E0D\u81EA\u52A8\u4FDD\u5B58\u3002\u4EC5\u5728\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u672C\u6B21\u5177\u4F53\u65B0\u589E\u65F6\u8C03\u7528\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "title", "subtitle", "confirm"], properties: {
      path: { type: "string" },
      title: { type: "string", maxLength: 200 },
      subtitle: { type: "string", maxLength: 2e3 },
      confirm: { type: "boolean" }
    } },
    execute: async (args = {}) => bridge({ host: "presentation", action: "add_slide", params: args, confirm: args.confirm })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_save_document",
    description: "\u4FDD\u5B58 WPS \u4E2D\u5F53\u524D\u5DF2\u4FEE\u6539\u7684\u6587\u5B57\u3001\u8868\u683C\u6216\u6F14\u793A\u6587\u4EF6\u3002\u4F1A\u5199\u5165\u539F\u6587\u4EF6\uFF0C\u53EA\u6709\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u4FDD\u5B58\u8BE5\u6587\u4EF6\u65F6\u624D\u80FD\u8C03\u7528\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["host", "path", "confirm"], properties: {
      host: hostSchema,
      path: { type: "string" },
      confirm: { type: "boolean" }
    } },
    execute: async (args = {}) => bridge({ host: args.host, action: "save", params: { path: args.path }, confirm: args.confirm })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_export_pdf",
    description: "\u4F7F\u7528\u672C\u673A WPS \u5C06\u5DF2\u6253\u5F00\u7684\u6587\u5B57\u3001\u8868\u683C\u6216\u6F14\u793A\u6587\u4EF6\u5BFC\u51FA\u4E3A\u65B0\u7684 PDF\u3002\u82E5\u6587\u4EF6\u5C1A\u672A\u6253\u5F00\uFF0C\u5148\u8C03\u7528 wps_open_document\u3002\u5BFC\u51FA\u540E\u6838\u9A8C PDF\uFF0C\u518D\u4EA4\u4ED8\u5230 output \u6307\u5B9A\u7684\u65B0\u8DEF\u5F84\uFF1B\u4E0D\u8986\u76D6\u5DF2\u6709\u6587\u4EF6\u3002\u7ED3\u679C\u7684 output \u662F\u7528\u6237\u6307\u5B9A\u8DEF\u5F84\uFF0CcanonicalOutput \u662F\u540C\u4E00\u4E2A\u6587\u4EF6\u7684\u89C4\u8303\u5316\u8DEF\u5F84\uFF1B\u4E0D\u8981\u5C06\u4E24\u8005\u8BF4\u6210\u4E0D\u540C\u6587\u4EF6\u3002\u53EA\u6709\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u6216\u786E\u8BA4\u672C\u6B21\u5BFC\u51FA\u65F6\u624D\u80FD\u4F20 confirm=true\u3002\u5931\u8D25\u6216\u7ED3\u679C\u4E0D\u660E\u65F6\u4E0D\u5F97\u81EA\u52A8\u91CD\u8BD5\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["host", "path", "output", "confirm"], properties: {
      host: hostSchema,
      path: { type: "string", description: "\u5DF2\u5728 WPS \u6253\u5F00\u7684\u539F\u6587\u6863\u7EDD\u5BF9\u8DEF\u5F84" },
      output: { type: "string", description: "\u65B0\u7684 PDF \u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u7236\u76EE\u5F55\u987B\u5DF2\u5B58\u5728" },
      confirm: { type: "boolean", description: "\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u6216\u786E\u8BA4\u8FD9\u6B21\u5BFC\u51FA\u65F6\u4E3A true" }
    } },
    execute: async (args = {}) => bridge({ host: args.host, action: "export_pdf", params: { path: args.path }, output: args.output, confirm: args.confirm })
  }));
  dispose.push(ctx.tools.register({
    name: "wps_create_document",
    description: "\u76F4\u63A5\u8BA9\u672C\u673A WPS \u65B0\u5EFA\u6587\u5B57\u3001\u8868\u683C\u6216\u6F14\u793A\u6587\u4EF6\uFF0C\u5E76\u4FDD\u5B58\u5230 output \u6307\u5B9A\u7684\u65B0\u8DEF\u5F84\uFF1B\u4E0D\u8986\u76D6\u5DF2\u6709\u6587\u4EF6\u3002\u6587\u5B57\u4F20 text\uFF1B\u8868\u683C\u4F20 cells\uFF08\u6BCF\u9879\u4E3A address\u3001value\uFF09\uFF1B\u6F14\u793A\u4F20 slides\uFF08\u6BCF\u9879\u4E3A title\u3001subtitle\uFF09\u3002\u7ED3\u679C\u7684 output \u662F\u7528\u6237\u6307\u5B9A\u8DEF\u5F84\uFF0CcanonicalOutput \u662F\u540C\u4E00\u4E2A\u6587\u4EF6\u7684\u89C4\u8303\u5316\u8DEF\u5F84\uFF1B\u4E0D\u8981\u5C06\u4E24\u8005\u8BF4\u6210\u4E0D\u540C\u6587\u4EF6\u3002\u53EA\u6709\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u672C\u6B21\u521B\u5EFA\u65F6\u624D\u80FD\u4F20 confirm=true\u3002\u5931\u8D25\u6216\u7ED3\u679C\u4E0D\u660E\u65F6\u4E0D\u5F97\u81EA\u52A8\u91CD\u8BD5\u3002",
    inputSchema: { type: "object", additionalProperties: false, required: ["host", "output", "confirm"], properties: {
      host: hostSchema,
      output: { type: "string", description: "\u672C\u673A\u65B0\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6587\u5B57 .docx\u3001\u8868\u683C .xlsx\u3001\u6F14\u793A .pptx\uFF1B\u7236\u76EE\u5F55\u987B\u5DF2\u5B58\u5728" },
      text: { type: "string", maxLength: 12e3, description: "\u6587\u5B57\u6587\u6863\u6B63\u6587\uFF1Bhost=word \u65F6\u5FC5\u586B" },
      cells: { type: "array", maxItems: 500, description: "\u8868\u683C\u5355\u5143\u683C\uFF1Bhost=spreadsheet \u65F6\u5FC5\u586B", items: {
        type: "object",
        additionalProperties: false,
        required: ["address", "value"],
        properties: {
          address: { type: "string", description: "\u5982 A1" },
          value: { type: ["string", "number", "boolean"] }
        }
      } },
      slides: { type: "array", minItems: 1, maxItems: 20, description: "\u6F14\u793A\u9875\u9762\uFF1Bhost=presentation \u65F6\u5FC5\u586B", items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "subtitle"],
        properties: {
          title: { type: "string", maxLength: 200 },
          subtitle: { type: "string", maxLength: 2e3 }
        }
      } },
      confirm: { type: "boolean", description: "\u5F8B\u5E08\u660E\u786E\u8981\u6C42\u6216\u786E\u8BA4\u521B\u5EFA\u8BE5\u6587\u4EF6\u65F6\u4E3A true" }
    } },
    execute: async (args = {}) => bridge({
      host: args.host,
      action: "create_document",
      output: args.output,
      text: args.text,
      cells: args.cells,
      slides: args.slides,
      confirm: args.confirm
    })
  }));
  return () => {
    for (const fn of dispose.reverse()) fn();
  };
}
export {
  activate as default
};
