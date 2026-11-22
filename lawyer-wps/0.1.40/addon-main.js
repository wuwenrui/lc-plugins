/* LawyerCopilot local WPS add-in. No document data leaves the loopback bridge. */
var LC_WPS_CONFIG = __LC_WPS_CONFIG__;
var LC_WPS_STARTED = false;
var LC_WPS_BUSY = false;
var LC_WPS_TIMER = null;
var LC_WPS_INSTANCE = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
var LC_WPS_SEEN = [];
var LC_WPS_LAST = 'starting';

function lcError(code, message) { var error = new Error(message); error.code = code; return error; }
function lcString(value) { return value == null ? '' : String(value); }
function lcCount(collection) {
  var value = Number(collection && collection.Count);
  if (!isFinite(value) || value < 0 || Math.floor(value) !== value) throw lcError('WPS_API_UNAVAILABLE', 'WPS 集合无效');
  return value;
}
function lcHost() {
  if (typeof Application === 'undefined' || !Application) return '';
  try { if (Application.Documents) return 'word'; } catch (_wordError) {}
  try { if (Application.Workbooks) return 'spreadsheet'; } catch (_sheetError) {}
  try { if (Application.Presentations) return 'presentation'; } catch (_slidesError) {}
  return '';
}
function lcCollection(host) {
  if (host === 'word') return Application.Documents;
  if (host === 'spreadsheet') return Application.Workbooks;
  if (host === 'presentation') return Application.Presentations;
  throw lcError('HOST_UNAVAILABLE', 'WPS 组件暂不可用');
}
function lcDocumentPath(doc) {
  try { var name = lcString(doc.FullName); return name.charAt(0) === '/' ? name : ''; }
  catch (_error) { return ''; }
}
function lcFind(host, expectedPath) {
  var collection = lcCollection(host);
  for (var i = 1; i <= lcCount(collection); i++) {
    var doc = collection.Item(i);
    if (lcDocumentPath(doc) === expectedPath) return doc;
  }
  throw lcError('DOCUMENT_NOT_OPEN', '指定文件没有在对应的 WPS 组件中打开');
}
function lcList(host) {
  var collection = lcCollection(host);
  var total = lcCount(collection);
  var rows = [];
  for (var i = 1; i <= Math.min(total, 100); i++) {
    var doc = collection.Item(i);
    rows.push({ path: lcDocumentPath(doc), name: lcString(doc.Name), host: host });
  }
  return { documents: rows, total: total, truncated: total > rows.length };
}
function lcUniqueRange(doc, quote) {
  var text = lcString(doc.Content.Text);
  var start = text.indexOf(quote);
  if (!quote || start < 0) throw lcError('QUOTE_NOT_FOUND', '要修改的原文不存在');
  if (text.indexOf(quote, start + 1) >= 0) throw lcError('AMBIGUOUS_QUOTE', '原文出现多次，请提供更长的唯一片段');
  var range = doc.Range(start, start + quote.length);
  if (lcString(range.Text) !== quote) throw lcError('DOCUMENT_CHANGED', '文档内容已变化，请重新读取');
  return range;
}
function lcTextVersion(text) {
  var first = 2166136261;
  var second = 5381;
  for (var i = 0; i < text.length; i++) {
    first = Math.imul(first ^ text.charCodeAt(i), 16777619) >>> 0;
    second = (Math.imul(second, 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return text.length + ':' + ('00000000' + first.toString(16)).slice(-8) + ('00000000' + second.toString(16)).slice(-8);
}
function lcWordVersion(doc) {
  var content = doc.Content;
  var snapshot = [lcString(content.Text)];
  try { snapshot.push('comments=' + lcCount(doc.Comments)); } catch (_commentsError) {}
  try { snapshot.push('revisions=' + lcCount(doc.Revisions)); } catch (_revisionsError) {}
  try { snapshot.push('inlineShapes=' + lcCount(doc.InlineShapes)); } catch (_imageError) {}
  try { snapshot.push('tables=' + lcCount(doc.Tables)); } catch (_tableError) {}
  try { snapshot.push('saved=' + lcString(doc.Saved)); } catch (_savedError) {}
  try {
    var font = content.Font;
    snapshot.push('font=' + [font.Bold, font.Italic, font.Size, font.Name].map(lcString).join('|'));
  } catch (_fontError) {}
  try {
    var page = doc.PageSetup;
    snapshot.push('page=' + [page.LeftMargin, page.RightMargin, page.TopMargin,
      page.BottomMargin, page.Orientation].map(lcString).join('|'));
  } catch (_pageError) {}
  return lcTextVersion(snapshot.join('\u0000'));
}
function lcFontEnabled(value) { return value === -1 || value === 1 ? true : value === 0 ? false : null; }
function lcInspect(doc, members) {
  if (!Array.isArray(members) || members.length < 1 || members.length > 12) throw lcError('INVALID_PATH', '检查路径须包含 1 至 12 个步骤');
  var current = doc;
  var blocked = { Application: true, Parent: true, VBProject: true, CodeModule: true, Constructor: true,
    constructor: true, __proto__: true, prototype: true, Run: true, Shell: true };
  for (var step = 0; step < members.length; step++) {
    var member = members[step];
    if (typeof member === 'number' && isFinite(member) && Math.floor(member) === member && member >= 1 && member <= 100000) {
      if (!current || typeof current.Item !== 'function') throw lcError('INVALID_PATH', '当前对象不能按序号取项');
      current = current.Item(member);
    } else if (typeof member === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(member) && !blocked[member]) {
      if (current == null) throw lcError('INVALID_PATH', '检查路径中途为空');
      current = current[member];
    } else throw lcError('INVALID_PATH', '检查路径包含不允许的成员');
  }
  if (current == null) return { kind: 'empty', value: null };
  if (typeof current === 'string') return { kind: 'text', value: current.slice(0, 12000), truncated: current.length > 12000 };
  if (typeof current === 'number' && members[members.length - 2] === 'Font'
      && ['Bold', 'Italic'].indexOf(members[members.length - 1]) >= 0) {
    return { kind: 'number', value: current, enabled: lcFontEnabled(current) };
  }
  if (typeof current === 'number' || typeof current === 'boolean') return { kind: typeof current, value: current };
  if (Array.isArray(current)) {
    var serial = JSON.stringify(current);
    if (serial && serial.length <= 40000) return { kind: 'array', value: current };
    throw lcError('VALUE_TOO_LARGE', '返回值过大，请缩小检查范围');
  }
  var summary = { kind: typeof current };
  try { if (typeof current.Count === 'number') summary.count = lcCount(current); } catch (_countError) {}
  try { if (typeof current.Name === 'string') summary.name = current.Name.slice(0, 200); } catch (_nameError) {}
  return summary;
}
function lcApiMember(member) {
  var denied = ['application', 'parent', 'vbproject', 'codemodule', 'constructor', 'prototype',
    'run', 'shell', 'execute', 'quit', 'close', 'delete', 'save', 'saveas', 'saveas2',
    'open', 'export', 'filedialog', 'createobject', 'getobject', 'macros', 'addins',
    'tostring', 'tolocalestring', 'valueof', 'hasownproperty', 'isprototypeof', 'propertyisenumerable'];
  if (typeof member !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(member)
      || denied.indexOf(member.toLowerCase()) >= 0
      || /oleobject|olecontrol|activex|dde|macro|script|execute/.test(member.toLowerCase())) {
    throw lcError('INVALID_PATH', '该 WPS 对象成员不允许访问');
  }
  return member;
}
function lcSafeCellValue(value) {
  return typeof value !== 'string' || !/^[\s\u0000-\u001f]*[=+@-]/.test(value);
}
function lcSafeLocalFormula(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 512
      || !/^=[A-Za-z0-9$+\-*/^().,:<>=]+$/.test(value)) return false;
  var expression = value.slice(1).toUpperCase();
  var tokens = expression.match(/\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}|[A-Z][A-Z0-9]*|[0-9]+(?:\.[0-9]+)?|[+\-*/^(),:<>=]/g);
  if (!tokens || tokens.join('') !== expression) return false;
  var functions = { SUM: true, AVERAGE: true, MIN: true, MAX: true, COUNT: true,
    ROUND: true, ABS: true, IF: true, SQRT: true, POWER: true, MOD: true };
  var rangeFunctions = { SUM: true, AVERAGE: true, MIN: true, MAX: true, COUNT: true };
  function cellCoordinates(token) {
    var match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(token);
    if (!match || Number(match[2]) > 1048576) return null;
    var column = 0;
    for (var i = 0; i < match[1].length; i++) column = column * 26 + match[1].charCodeAt(i) - 64;
    return column <= 16384 ? { column: column, row: Number(match[2]) } : null;
  }
  function cell(token) { return cellCoordinates(token) !== null; }
  var stack = [];
  var referencedRangeCells = 0;
  for (var index = 0; index < tokens.length; index++) {
    var token = tokens[index];
    if (/^[A-Z$]/.test(token)) {
      if (tokens[index + 1] === '(') { if (!functions[token]) return false; }
      else if (!cell(token)) return false;
    } else if (token === '(') {
      stack.push(functions[tokens[index - 1]] ? tokens[index - 1] : null);
      if (stack.length > 16) return false;
    } else if (token === ')') { if (!stack.length) return false; stack.pop(); }
    else if (token === ':') {
      var first = cellCoordinates(tokens[index - 1] || '');
      var last = cellCoordinates(tokens[index + 1] || '');
      if (!rangeFunctions[stack[stack.length - 1]] || !first || !last
          || last.column < first.column || last.row < first.row) return false;
      referencedRangeCells += (last.column - first.column + 1) * (last.row - first.row + 1);
      if (referencedRangeCells > 10000) return false;
    }
    else if (token === ',' && (!stack.length || !stack[stack.length - 1])) return false;
  }
  return stack.length === 0;
}
function lcStagedOutput(value, extension) {
  var root = LC_WPS_CONFIG.exportRoot;
  return typeof root === 'string' && typeof value === 'string'
    && value.indexOf(root + '/job-') === 0
    && new RegExp('^[A-Za-z0-9-]{6,64}/output\\.' + extension + '$').test(value.slice((root + '/job-').length));
}
function lcStagedImage(value) {
  var root = LC_WPS_CONFIG.exportRoot;
  return typeof root === 'string' && typeof value === 'string'
    && value.indexOf(root + '/job-') === 0
    && /^[A-Za-z0-9-]{6,64}\/source\.(png|jpg|jpeg)$/.test(value.slice((root + '/job-').length));
}
function lcBootstrapPath(value, extension) {
  var root = LC_WPS_CONFIG.exportRoot;
  return typeof root === 'string' && typeof value === 'string'
    && value.indexOf(root + '/boot-') === 0
    && new RegExp('^[A-Za-z0-9-]{6,64}/bootstrap\\.' + extension + '$').test(value.slice((root + '/boot-').length));
}
function lcApiSetAllowed(host, route, member, value, source) {
  var fontValue = (['Bold', 'Italic'].indexOf(member) >= 0 && (typeof value === 'boolean' || value === 0 || value === 1 || value === -1))
    || (member === 'Size' && typeof value === 'number' && isFinite(value) && value >= 1 && value <= 200)
    || (member === 'Name' && typeof value === 'string' && value.length > 0 && value.length <= 200);
  if (host === 'word' && /^document\.(Content|Paragraphs\.Item\.Range)\.Font$/.test(route) && fontValue) return true;
  if (host === 'word' && /^document\.(Content|Paragraphs\.Item\.Range)\.ParagraphFormat$/.test(route)
      && typeof value === 'number' && isFinite(value)) {
    if (member === 'Alignment' && Number.isInteger(value) && value >= 0 && value <= 4) return true;
    if (['SpaceBefore', 'SpaceAfter', 'LineSpacing'].indexOf(member) >= 0 && value >= 0 && value <= 1000) return true;
  }
  if (host === 'word' && /^document(?:\.Sections\.Item)?\.PageSetup$/.test(route)) {
    if (['LeftMargin', 'RightMargin', 'TopMargin', 'BottomMargin'].indexOf(member) >= 0
        && typeof value === 'number' && isFinite(value) && value >= 0 && value <= 360) return true;
    if (member === 'Orientation' && (value === 0 || value === 1)) return true;
  }
  if (host === 'spreadsheet' && /^document\.(ActiveSheet|Worksheets\.Item)\.Range\(\)$/.test(route)
      && ((member === 'Value2' && lcSafeCellValue(value)) || member === 'NumberFormat')) return true;
  if (host === 'spreadsheet' && /^document\.(ActiveSheet|Worksheets\.Item)\.Range\(\)$/.test(route)
      && member === 'Formula' && lcSafeLocalFormula(value)) {
    try { return lcCount(source) === 1; } catch (_rangeError) { return false; }
  }
  if (host === 'spreadsheet' && /^document\.(ActiveSheet|Worksheets\.Item)\.Range\(\)\.Font$/.test(route) && fontValue) return true;
  if (host === 'presentation' && /^document\.Slides\.Item\.Shapes\.(Title|Item)\.TextFrame\.TextRange$/.test(route)
      && member === 'Text' && typeof value === 'string') return true;
  if (host === 'presentation' && /^document\.Slides\.Item\.Shapes\.(Title|Item)\.TextFrame\.TextRange\.Font$/.test(route)
      && fontValue) return true;
  return false;
}
function lcApiCallAllowed(host, route, member, rawArgs, args, paths, edit, doc) {
  if (host === 'word' && route === 'document' && member === 'Range' && args.length === 2
      && Number.isInteger(args[0]) && Number.isInteger(args[1]) && args[0] >= 0
      && args[1] >= args[0] && args[1] <= lcString(doc.Content.Text).length
      && args[1] - args[0] <= 12000) return true;
  if (edit && host === 'word' && route === 'document.Comments' && member === 'Add' && args.length === 2
      && rawArgs[0] && Number.isInteger(rawArgs[0].ref)
      && /^document\.(Content|Paragraphs\.Item\.Range)$/.test(paths[rawArgs[0].ref] || '')
      && typeof args[1] === 'string' && args[1].length > 0 && args[1].length <= 2000) return true;
  if (/^document\.(Shapes|Slides\.Item\.Shapes)$/.test(route) && member === 'Range'
      && args.length === 1 && Array.isArray(args[0]) && args[0].length > 0 && args[0].length <= 100
      && args[0].every(function (index) { return Number.isInteger(index) && index >= 1 && index <= 100000; })) return true;
  if (host === 'spreadsheet' && /^document\.(ActiveSheet|Worksheets\.Item)$/.test(route)
      && member === 'Range' && args.length === 1 && typeof args[0] === 'string') {
    var match = /^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/.exec(args[0].toUpperCase());
    if (!match) return false;
    function columnNumber(letters) {
      var column = 0;
      for (var letter = 0; letter < letters.length; letter++) column = column * 26 + letters.charCodeAt(letter) - 64;
      return column;
    }
    var firstColumn = columnNumber(match[1]);
    var lastColumn = columnNumber(match[3] || match[1]);
    var firstRow = Number(match[2]);
    var lastRow = Number(match[4] || match[2]);
    return lastColumn >= firstColumn && lastRow >= firstRow
      && (lastColumn - firstColumn + 1) * (lastRow - firstRow + 1) <= 500;
  }
  return false;
}
function lcApiSummary(value, route) {
  if (value == null) return { kind: 'empty', value: null };
  if (typeof value === 'string') return { kind: 'text', value: value.slice(0, 12000), truncated: value.length > 12000 };
  if (typeof value === 'number' && /\.Font\.(Bold|Italic)$/.test(route || '')) {
    return { kind: 'number', value: value, enabled: lcFontEnabled(value) };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { kind: typeof value, value: value };
  if (Array.isArray(value)) {
    var serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 12000) throw lcError('VALUE_TOO_LARGE', 'WPS 返回数组过大，请缩小读取范围');
    return { kind: 'array', value: JSON.parse(serialized) };
  }
  var result = { kind: typeof value };
  try { if (typeof value.Count === 'number') result.count = lcCount(value); } catch (_countError) {}
  try { if (typeof value.Name === 'string') result.name = value.Name.slice(0, 200); } catch (_nameError) {}
  return result;
}
function lcApiArgument(value, prior, depth) {
  depth = depth || 0;
  if (Array.isArray(value)) {
    if (depth >= 2 || value.length > 100) throw lcError('INVALID_VALUE', 'WPS 数组参数过大');
    var items = [];
    for (var item = 0; item < value.length; item++) items.push(lcApiArgument(value[item], prior, depth + 1));
    return items;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    var keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'ref' && Number.isInteger(value.ref)
        && value.ref >= 0 && value.ref < prior.length) return prior[value.ref];
    throw lcError('INVALID_VALUE', 'WPS 方法参数对象只允许引用前一步结果');
  }
  if (typeof value === 'string' && value.length <= 10000) return value;
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  throw lcError('INVALID_VALUE', 'WPS 方法参数无效');
}
function lcApiSteps(doc, steps, edit, host) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw lcError('INVALID_STEPS', 'WPS 操作步骤须为 1 至 20 项');
  var values = [];
  var results = [];
  var routes = [];
  var observedSources = [];
  var observedMembers = [];
  var mutated = false;
  for (var i = 0; i < steps.length; i++) {
    try {
    var step = steps[i];
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw lcError('INVALID_STEPS', 'WPS 操作步骤格式无效');
    var source;
    var sourceRoute;
    if (step.from === 'document') { source = doc; sourceRoute = 'document'; }
    else if (Number.isInteger(step.from) && step.from >= 0 && step.from < i) {
      source = values[step.from]; sourceRoute = routes[step.from];
    }
    else throw lcError('INVALID_PATH', 'WPS 操作引用无效');
    if (source == null) throw lcError('INVALID_PATH', 'WPS 操作对象不存在');
    if (step.op === 'probe') {
      if (edit || i !== steps.length - 1) throw lcError('INVALID_STEPS', 'WPS 探测只能是只读操作的最后一步');
      var probedMember = lcApiMember(step.member);
      var candidate = source[probedMember];
      var probe = { kind: candidate == null ? 'empty' : typeof candidate, callAllowed: false, setAllowed: false };
      if (typeof candidate === 'function') {
        probe.kind = 'method';
        if (Array.isArray(step.args) && step.args.length <= 8) {
          var probeArgs = [];
          for (var probeIndex = 0; probeIndex < step.args.length; probeIndex++) {
            probeArgs.push(lcApiArgument(step.args[probeIndex], values));
          }
          probe.callAllowed = lcApiCallAllowed(host, sourceRoute, probedMember, step.args, probeArgs, routes, false, doc);
        }
      } else if (Object.prototype.hasOwnProperty.call(step, 'value')) {
        probe.setAllowed = lcApiSetAllowed(host, sourceRoute, probedMember, step.value, source);
      }
      results.push(probe);
      if (JSON.stringify(results).length > 12000) throw lcError('VALUE_TOO_LARGE', 'WPS 操作返回内容过大，请分段读取');
      return { results: results, saved: false };
    }
    var value;
    var resultRoute;
    if (step.op === 'get') {
      var readableMember = lcApiMember(step.member);
      value = source[readableMember];
      resultRoute = sourceRoute + '.' + readableMember;
    }
    else if (step.op === 'item') {
      var numericIndex = Number.isInteger(step.index) && step.index >= 1 && step.index <= 100000;
      var sheetName = host === 'spreadsheet' && sourceRoute === 'document.Worksheets'
        && typeof step.index === 'string' && step.index.length >= 1 && step.index.length <= 100
        && !/[\u0000-\u001f]/.test(step.index);
      if (typeof source.Item !== 'function' || !(numericIndex || sheetName)) {
        throw lcError('INVALID_PATH', '集合序号无效');
      }
      value = source.Item(step.index);
      resultRoute = sourceRoute + '.Item';
    } else if (step.op === 'set' && edit) {
      if (!['string', 'number', 'boolean'].includes(typeof step.value)
          || (typeof step.value === 'string' && step.value.length > 10000)
          || (typeof step.value === 'number' && !isFinite(step.value))) {
        throw lcError('INVALID_VALUE', 'WPS 属性值无效');
      }
      var writableMember = lcApiMember(step.member);
      if (!lcApiSetAllowed(host, sourceRoute, writableMember, step.value, source)) {
        throw lcError('INVALID_PATH', '该 WPS 属性修改不允许');
      }
      var hasExpected = Object.prototype.hasOwnProperty.call(step, 'expectedValue');
      var expectedValue = step.expectedValue;
      if (!hasExpected) {
        for (var priorIndex = i - 1; priorIndex >= 0; priorIndex--) {
          if (steps[priorIndex].op === 'get' && observedSources[priorIndex] === source
              && observedMembers[priorIndex] === writableMember) {
            expectedValue = values[priorIndex];
            hasExpected = true;
            break;
          }
        }
      }
      if (!hasExpected || (expectedValue !== null && !['string', 'number', 'boolean'].includes(typeof expectedValue))
          || (source[writableMember] == null ? null : source[writableMember]) !== expectedValue) {
        throw lcError('DOCUMENT_CHANGED', '修改前需要先读取属性预期值；属性已变化时请重新读取');
      }
      mutated = true;
      source[writableMember] = step.value;
      value = source[writableMember];
      resultRoute = sourceRoute + '.' + writableMember;
    } else if (step.op === 'call') {
      var method = source[lcApiMember(step.member)];
      if (typeof method !== 'function' || !Array.isArray(step.args) || step.args.length > 8) {
        throw lcError('INVALID_STEPS', 'WPS 方法或参数无效');
      }
      var args = [];
      for (var argumentIndex = 0; argumentIndex < step.args.length; argumentIndex++) {
        args.push(lcApiArgument(step.args[argumentIndex], values));
      }
      if (!lcApiCallAllowed(host, sourceRoute, step.member, step.args, args, routes, edit, doc)) {
        throw lcError('INVALID_PATH', '该 WPS 方法调用不允许');
      }
      if (step.member === 'Add') mutated = true;
      value = method.apply(source, args);
      resultRoute = sourceRoute + '.' + step.member + '()';
    } else throw lcError('INVALID_STEPS', '此模式不允许该 WPS 操作');
    if (typeof value === 'function') {
      if (step.op === 'get' && host === 'spreadsheet' && readableMember === 'Range'
          && /^document\.(ActiveSheet|Worksheets\.Item)$/.test(sourceRoute)) {
        throw lcError('METHOD_REQUIRES_CALL', 'Range 是方法，不是属性；请从同一工作表步骤使用 op=call、member=Range、args=["C1"]，再对返回的 Range 使用 get Formula 或 get Value2');
      }
      throw lcError('METHOD_REQUIRES_CALL', '不允许通过 get 返回可调用函数；该成员是方法，请在允许的方法范围内使用 op=call 并提供 args');
    }
    values.push(value);
    routes.push(resultRoute);
    observedSources.push(step.op === 'get' ? source : null);
    observedMembers.push(step.op === 'get' ? readableMember : null);
    results.push(lcApiSummary(value, resultRoute));
    if (JSON.stringify(results).length > 12000) throw lcError('VALUE_TOO_LARGE', 'WPS 操作返回内容过大，请分段读取');
    } catch (error) {
      if (edit && mutated) throw lcError('PARTIAL_WRITE', 'WPS 可能已执行部分修改，请在 WPS 中核查后再决定保存或撤销；不要自动重试');
      throw error;
    }
  }
  return { results: results, saved: false };
}
function lcMutation(work) {
  try { return work(); }
  catch (_error) { throw lcError('PARTIAL_WRITE', 'WPS 可能已执行部分修改，请在 WPS 中核查后再决定保存或撤销；不要自动重试'); }
}
function lcExecute(command) {
  var host = lcHost();
  if (!host || host !== command.host) throw lcError('HOST_MISMATCH', 'WPS 组件不匹配');
  var p = command.params || {};
  if (command.action === 'list') return lcList(host);
  if (command.action === 'create_document') {
    var extension = host === 'word' ? 'docx' : host === 'spreadsheet' ? 'xlsx' : 'pptx';
    if (!lcStagedOutput(p.output, extension)) throw lcError('INVALID_OUTPUT', '新文档输出路径不在本插件的本机暂存目录');
    if (p.bootstrapPath !== undefined && !lcBootstrapPath(p.bootstrapPath, extension)) {
      throw lcError('INVALID_PATH', 'WPS 组件启动文件路径无效');
    }
    if (host === 'word' && (typeof p.text !== 'string' || p.text.length > 12000)) {
      throw lcError('INVALID_CONTENT', '文字内容无效或过长');
    }
    if (host === 'spreadsheet') {
      if (!Array.isArray(p.cells) || p.cells.length > 500) throw lcError('INVALID_CONTENT', '表格单元格数量无效');
      var seenCells = {};
      for (var c = 0; c < p.cells.length; c++) {
        var cell = p.cells[c];
        if (!cell || typeof cell !== 'object' || typeof cell.address !== 'string'
            || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell.address) || seenCells[cell.address]
            || !['string', 'number', 'boolean'].includes(typeof cell.value)
            || (typeof cell.value === 'number' && !isFinite(cell.value))
            || (typeof cell.value === 'string' && (cell.value.length > 2000 || !lcSafeCellValue(cell.value)))) {
          throw lcError('INVALID_CONTENT', '单元格无效、重复或包含不允许的公式');
        }
        var addressParts = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(cell.address);
        var column = 0;
        for (var letter = 0; letter < addressParts[1].length; letter++) column = column * 26 + addressParts[1].charCodeAt(letter) - 64;
        if (column > 16384 || Number(addressParts[2]) > 1048576) throw lcError('INVALID_CONTENT', '单元格无效，超出工作表范围');
        seenCells[cell.address] = true;
      }
    }
    if (host === 'presentation') {
      if (!Array.isArray(p.slides) || p.slides.length < 1 || p.slides.length > 20) throw lcError('INVALID_CONTENT', '演示页数无效');
      for (var s = 0; s < p.slides.length; s++) {
        var slideContent = p.slides[s];
        if (!slideContent || typeof slideContent.title !== 'string' || slideContent.title.length > 200
            || typeof slideContent.subtitle !== 'string' || slideContent.subtitle.length > 2000) {
          throw lcError('INVALID_CONTENT', '演示标题或正文无效');
        }
      }
    }
    return lcMutation(function () {
      var created;
      if (host === 'word') {
        created = Application.Documents.Add();
        created.Content.Text = p.text;
        created.SaveAs2(p.output, 12);
        created.Close(0);
      } else if (host === 'spreadsheet') {
        created = Application.Workbooks.Add();
        for (var cellIndex = 0; cellIndex < p.cells.length; cellIndex++) {
          created.ActiveSheet.Range(p.cells[cellIndex].address).Value2 = p.cells[cellIndex].value;
        }
        created.SaveAs(p.output, 51);
        created.Close(false);
      } else {
        created = Application.Presentations.Add();
        var titleLayout = typeof ppLayoutTitle !== 'undefined' ? ppLayoutTitle : 1;
        for (var slideIndex = 0; slideIndex < p.slides.length; slideIndex++) {
          var slide = created.Slides.Add(slideIndex + 1, titleLayout);
          slide.Shapes.Title.TextFrame.TextRange.Text = p.slides[slideIndex].title;
          slide.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = p.slides[slideIndex].subtitle;
        }
        created.SaveAs(p.output, 24);
        created.Close();
      }
      var bootstrapClosed = !p.bootstrapPath;
      if (p.bootstrapPath) {
        var bootstrap;
        try { bootstrap = lcFind(host, p.bootstrapPath); }
        catch (error) { if (error.code !== 'DOCUMENT_NOT_OPEN') throw error; }
        if (bootstrap) {
          if (host === 'word') bootstrap.Close(0);
          else if (host === 'spreadsheet') bootstrap.Close(false);
          else bootstrap.Close();
          bootstrapClosed = true;
        }
      }
      return { created: true, host: host, saved: true, bootstrapClosed: bootstrapClosed };
    });
  }
  if (typeof p.path !== 'string' || p.path.charAt(0) !== '/') throw lcError('INVALID_PATH', '需要已打开文件的本机路径');
  var doc = lcFind(host, p.path);
  if (command.action === 'inspect') return { path: p.path, members: p.members, result: lcInspect(doc, p.members) };
  if (command.action === 'api_read' || command.action === 'api_edit') {
    if (command.action === 'api_edit' && host === 'word') {
      if (typeof p.expectedVersion !== 'string' || !/^[0-9]+:[a-f0-9]{16}$/.test(p.expectedVersion)) {
        throw lcError('INVALID_VERSION', '修改前需要先读取当前文档版本');
      }
      if (lcWordVersion(doc) !== p.expectedVersion) {
        throw lcError('DOCUMENT_CHANGED', '文档版本已变化，请重新读取后再修改');
      }
    }
    var performed = lcApiSteps(doc, p.steps, command.action === 'api_edit', host);
    return { path: p.path, results: performed.results, saved: performed.saved };
  }
  if (command.action === 'read_word' && host === 'word') {
    var all = lcString(doc.Content.Text);
    var tableCount = null;
    try { tableCount = lcCount(doc.Tables); } catch (_tableError) {}
    var offset = Number(p.offset || 0);
    var limit = Number(p.limit || 12000);
    if (!isFinite(offset) || offset < 0 || Math.floor(offset) !== offset || !isFinite(limit) || limit < 1 || limit > 12000) throw lcError('INVALID_RANGE', '读取范围无效');
    return { path: p.path, totalCharacters: all.length, tableCount: tableCount,
      version: lcWordVersion(doc), offset: offset, text: all.slice(offset, offset + limit), more: offset + limit < all.length };
  }
  if (command.action === 'read_word_table' && host === 'word') {
    var tableNumber = p.table;
    var rowOffset = p.rowOffset === undefined ? 0 : p.rowOffset;
    var rowLimit = p.rowLimit === undefined ? 20 : p.rowLimit;
    var columnOffset = p.columnOffset === undefined ? 0 : p.columnOffset;
    var columnLimit = p.columnLimit === undefined ? 10 : p.columnLimit;
    if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > lcCount(doc.Tables)
        || !Number.isInteger(rowOffset) || rowOffset < 0 || !Number.isInteger(rowLimit)
        || rowLimit < 1 || rowLimit > 20 || !Number.isInteger(columnOffset) || columnOffset < 0
        || !Number.isInteger(columnLimit) || columnLimit < 1 || columnLimit > 10) {
      throw lcError('INVALID_TABLE_RANGE', '表格编号或读取页范围无效');
    }
    var selectedTable = doc.Tables.Item(tableNumber);
    var totalRows = lcCount(selectedTable.Rows);
    var totalColumns = lcCount(selectedTable.Columns);
    var dataRows = [];
    var totalCharacters = 0;
    for (var rowNumber = rowOffset + 1; rowNumber <= Math.min(totalRows, rowOffset + rowLimit); rowNumber++) {
      var dataRow = [];
      for (var columnNumber = columnOffset + 1;
        columnNumber <= Math.min(totalColumns, columnOffset + columnLimit); columnNumber++) {
        var cellText = lcString(selectedTable.Cell(rowNumber, columnNumber).Range.Text)
          .replace(/\r\u0007$/, '');
        totalCharacters += cellText.length;
        if (cellText.length > 2000 || totalCharacters > 12000) {
          throw lcError('VALUE_TOO_LARGE', '表格内容过多，请缩小读取范围');
        }
        dataRow.push(cellText);
      }
      dataRows.push(dataRow);
    }
    return { path: p.path, table: tableNumber, tableCount: lcCount(doc.Tables),
      totalRows: totalRows, totalColumns: totalColumns, rowOffset: rowOffset,
      columnOffset: columnOffset, rows: dataRows, moreRows: rowOffset + dataRows.length < totalRows,
      moreColumns: columnOffset + columnLimit < totalColumns, version: lcWordVersion(doc) };
  }
  if (command.action === 'replace_word' && host === 'word') {
    if (typeof p.quote !== 'string' || typeof p.replacement !== 'string' || p.quote.length > 2000 || p.replacement.length > 2000
        || typeof p.expectedVersion !== 'string' || !/^[0-9]+:[a-f0-9]{16}$/.test(p.expectedVersion)) throw lcError('INVALID_TEXT', '替换内容或文档版本无效');
    if (lcWordVersion(doc) !== p.expectedVersion) throw lcError('DOCUMENT_CHANGED', '文档已变化，请重新读取后再修改');
    var range = lcUniqueRange(doc, p.quote);
    return lcMutation(function () {
      doc.TrackRevisions = true;
      if (doc.TrackRevisions !== true && doc.TrackRevisions !== -1) throw lcError('TRACK_CHANGES_UNAVAILABLE', '无法启用修订');
      range.Text = p.replacement;
      return { path: p.path, changed: true, saved: false, trackChanges: true, version: lcWordVersion(doc) };
    });
  }
  if (command.action === 'append_word' && host === 'word') {
    if (typeof p.text !== 'string' || !p.text.length || p.text.length > 12000 || p.text.indexOf('\u0000') >= 0
        || typeof p.expectedVersion !== 'string' || !/^[0-9]+:[a-f0-9]{16}$/.test(p.expectedVersion)) {
      throw lcError('INVALID_TEXT', '追加正文或文档版本无效');
    }
    if (lcWordVersion(doc) !== p.expectedVersion) throw lcError('DOCUMENT_CHANGED', '文档已变化，请重新读取后再追加');
    var oldText = lcString(doc.Content.Text);
    return lcMutation(function () {
      doc.TrackRevisions = true;
      if (doc.TrackRevisions !== true && doc.TrackRevisions !== -1) throw lcError('TRACK_CHANGES_UNAVAILABLE', '无法启用修订');
      var insertion = doc.Content;
      insertion.Collapse(0);
      insertion.InsertAfter(p.text);
      var newText = lcString(doc.Content.Text);
      var tail = newText.slice(Math.max(0, oldText.length - 2)).replace(/\r\n?/g, '\n');
      if (newText.length <= oldText.length || tail.indexOf(p.text.replace(/\r\n?/g, '\n')) < 0) {
        throw lcError('WPS_WRITE_UNVERIFIED', 'WPS 未读回追加的正文');
      }
      return { path: p.path, appended: true, characters: p.text.length,
        saved: false, trackChanges: true, version: lcWordVersion(doc) };
    });
  }
  if (command.action === 'insert_table' && host === 'word') {
    if (typeof p.expectedVersion !== 'string' || !/^[0-9]+:[a-f0-9]{16}$/.test(p.expectedVersion)) {
      throw lcError('INVALID_VERSION', '插入表格前需要先读取当前文字文档版本');
    }
    if (lcWordVersion(doc) !== p.expectedVersion) throw lcError('DOCUMENT_CHANGED', '文档已变化，请重新读取后再插入表格');
    if (!Array.isArray(p.rows) || p.rows.length < 1 || p.rows.length > 20
        || !Array.isArray(p.rows[0]) || p.rows[0].length < 1 || p.rows[0].length > 10) {
      throw lcError('INVALID_TABLE', '表格需要 1 至 20 行、1 至 10 列');
    }
    var columnCount = p.rows[0].length;
    var tableCharacters = 0;
    for (var tableRow = 0; tableRow < p.rows.length; tableRow++) {
      if (!Array.isArray(p.rows[tableRow]) || p.rows[tableRow].length !== columnCount) {
        throw lcError('INVALID_TABLE', '表格各行列数必须相同');
      }
      for (var tableColumn = 0; tableColumn < columnCount; tableColumn++) {
        var cellText = p.rows[tableRow][tableColumn];
        if (typeof cellText !== 'string' || cellText.length > 2000) throw lcError('INVALID_TABLE', '表格单元格文字无效或过长');
        tableCharacters += cellText.length;
      }
    }
    if (tableCharacters > 10000) throw lcError('INVALID_TABLE', '表格内容总长度超过上限');
    return lcMutation(function () {
      doc.TrackRevisions = true;
      if (doc.TrackRevisions !== true && doc.TrackRevisions !== -1) throw lcError('TRACK_CHANGES_UNAVAILABLE', '无法启用修订');
      var insertion = doc.Content;
      insertion.Collapse(0);
      var table = doc.Tables.Add(insertion, p.rows.length, columnCount);
      for (var rowIndex = 0; rowIndex < p.rows.length; rowIndex++) {
        for (var columnIndex = 0; columnIndex < columnCount; columnIndex++) {
          if (p.rows[rowIndex][columnIndex]) table.Cell(rowIndex + 1, columnIndex + 1).Range.InsertAfter(p.rows[rowIndex][columnIndex]);
        }
      }
      return { path: p.path, rows: p.rows.length, columns: columnCount, saved: false,
        trackChanges: true, version: lcWordVersion(doc) };
    });
  }
  if (command.action === 'insert_image' && host === 'word') {
    if (typeof p.expectedVersion !== 'string' || !/^[0-9]+:[a-f0-9]{16}$/.test(p.expectedVersion)) {
      throw lcError('INVALID_VERSION', '插入图片前需要先读取当前文字文档版本');
    }
    if (!lcStagedImage(p.imagePath)) throw lcError('INVALID_IMAGE', '图片必须位于本插件的 WPS 暂存目录');
    if (lcWordVersion(doc) !== p.expectedVersion) throw lcError('DOCUMENT_CHANGED', '文档已变化，请重新读取后再插入图片');
    var beforeImageCount = lcCount(doc.InlineShapes);
    return lcMutation(function () {
      doc.TrackRevisions = true;
      if (doc.TrackRevisions !== true && doc.TrackRevisions !== -1) throw lcError('TRACK_CHANGES_UNAVAILABLE', '无法启用修订');
      var insertion = doc.Content;
      insertion.Collapse(0);
      doc.InlineShapes.AddPicture(p.imagePath, false, true, insertion);
      var afterImageCount = lcCount(doc.InlineShapes);
      if (afterImageCount !== beforeImageCount + 1) throw lcError('WPS_WRITE_UNVERIFIED', 'WPS 未读回新增图片');
      return { path: p.path, imageInserted: true, inlineShapes: afterImageCount, saved: false,
        trackChanges: true, version: lcWordVersion(doc) };
    });
  }
  if (command.action === 'insert_image' && host === 'presentation') {
    if (!lcStagedImage(p.imagePath)) throw lcError('INVALID_IMAGE', '图片必须位于本插件的 WPS 暂存目录');
    if (!Number.isInteger(p.slide) || p.slide < 1 || !Number.isInteger(p.expectedSlides)
        || !Number.isInteger(p.expectedShapeCount) || p.expectedShapeCount < 0
        || lcCount(doc.Slides) !== p.expectedSlides || p.slide > p.expectedSlides) {
      throw lcError('SLIDES_CHANGED', '幻灯片数量已变化，请重新读取');
    }
    var targetSlide = doc.Slides.Item(p.slide);
    var targetShapes = targetSlide.Shapes;
    var beforeShapeCount = lcCount(targetShapes);
    if (beforeShapeCount !== p.expectedShapeCount) throw lcError('SLIDE_CHANGED', '幻灯片元素数量已变化，请重新读取');
    var slideWidth = Number(doc.PageSetup.SlideWidth);
    var slideHeight = Number(doc.PageSetup.SlideHeight);
    if (![p.left, p.top, p.width, p.height, slideWidth, slideHeight].every(function (number) {
        return typeof number === 'number' && isFinite(number);
      }) || p.left < 0 || p.top < 0 || p.width <= 0 || p.height <= 0
        || p.left + p.width > slideWidth || p.top + p.height > slideHeight) {
      throw lcError('INVALID_PLACEMENT', '图片位置或大小超出幻灯片页面范围');
    }
    return lcMutation(function () {
      targetShapes.AddPicture(p.imagePath, 0, -1, p.left, p.top, p.width, p.height);
      var afterShapeCount = lcCount(targetShapes);
      if (afterShapeCount !== beforeShapeCount + 1) throw lcError('WPS_WRITE_UNVERIFIED', 'WPS 未读回新增图片');
      return { path: p.path, slide: p.slide, imageInserted: true,
        shapeCount: afterShapeCount, saved: false };
    });
  }
  if (command.action === 'read_workbook' && host === 'spreadsheet') {
    var rowOffset = p.rowOffset === undefined ? 0 : p.rowOffset;
    var rowLimit = p.rowLimit === undefined ? 20 : p.rowLimit;
    var columnOffset = p.columnOffset === undefined ? 0 : p.columnOffset;
    var columnLimit = p.columnLimit === undefined ? 10 : p.columnLimit;
    if (!Number.isInteger(rowOffset) || rowOffset < 0 || !Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 20
        || !Number.isInteger(columnOffset) || columnOffset < 0 || !Number.isInteger(columnLimit)
        || columnLimit < 1 || columnLimit > 10 || p.sheet !== undefined
        && (typeof p.sheet !== 'string' || !p.sheet || p.sheet.length > 100)) {
      throw lcError('INVALID_RANGE', '表格读取范围无效');
    }
    var worksheets = doc.Worksheets;
    var sheetCount = lcCount(worksheets);
    var sheetNames = [];
    for (var sheetIndex = 1; sheetIndex <= Math.min(sheetCount, 100); sheetIndex++) {
      sheetNames.push(lcString(worksheets.Item(sheetIndex).Name).slice(0, 100));
    }
    var selectedSheet = p.sheet ? worksheets.Item(p.sheet) : doc.ActiveSheet;
    if (!selectedSheet) throw lcError('SHEET_NOT_FOUND', '指定工作表不存在');
    var used = selectedSheet.UsedRange;
    var firstRow = Number(used.Row);
    var firstColumn = Number(used.Column);
    var totalRows = lcCount(used.Rows);
    var totalColumns = lcCount(used.Columns);
    if (!Number.isInteger(firstRow) || firstRow < 1 || !Number.isInteger(firstColumn) || firstColumn < 1
        || firstRow + totalRows > 1048577 || firstColumn + totalColumns > 16385) {
      throw lcError('INVALID_RANGE', 'WPS 已使用区域无效');
    }
    var dataRows = [];
    for (var rowNumber = rowOffset; rowNumber < Math.min(totalRows, rowOffset + rowLimit); rowNumber++) {
      var dataRow = [];
      for (var columnNumber = columnOffset; columnNumber < Math.min(totalColumns, columnOffset + columnLimit); columnNumber++) {
        var value = selectedSheet.Cells.Item(firstRow + rowNumber, firstColumn + columnNumber).Value2;
        if (value == null) value = null;
        else if (typeof value === 'string' && value.length <= 2000) {}
        else if (typeof value === 'number' && isFinite(value) || typeof value === 'boolean') {}
        else throw lcError('VALUE_TOO_LARGE', '单元格内容无法安全读取，请缩小范围');
        dataRow.push(value);
      }
      dataRows.push(dataRow);
    }
    if (JSON.stringify(dataRows).length > 40000) throw lcError('VALUE_TOO_LARGE', '表格内容过多，请缩小读取范围');
    return { path: p.path, sheet: lcString(selectedSheet.Name), sheetNames: sheetNames,
      sheetsTruncated: sheetCount > sheetNames.length, firstRow: firstRow, firstColumn: firstColumn,
      totalRows: totalRows, totalColumns: totalColumns, rowOffset: rowOffset,
      columnOffset: columnOffset, rows: dataRows, moreRows: rowOffset + dataRows.length < totalRows,
      moreColumns: columnOffset + columnLimit < totalColumns };
  }
  if (command.action === 'read_cells' && host === 'spreadsheet') {
    var sheet = typeof p.sheet === 'string' && p.sheet ? doc.Worksheets.Item(p.sheet) : doc.ActiveSheet;
    if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/.test(p.address || '')) throw lcError('INVALID_RANGE', '单元格范围无效');
    var rangeParts = p.address.split(':');
    function cellPosition(value) {
      var match = /^([A-Z]+)([0-9]+)$/.exec(value);
      var column = 0;
      for (var character = 0; character < match[1].length; character++) column = column * 26 + match[1].charCodeAt(character) - 64;
      return { column: column, row: Number(match[2]) };
    }
    var startCell = cellPosition(rangeParts[0]);
    var endCell = cellPosition(rangeParts[1] || rangeParts[0]);
    if (endCell.column < startCell.column || endCell.row < startCell.row
        || (endCell.column - startCell.column + 1) * (endCell.row - startCell.row + 1) > 500) {
      throw lcError('RANGE_TOO_LARGE', '每次最多读取 500 个连续单元格，请分段读取');
    }
    var values = sheet.Range(p.address).Value2;
    if (values === undefined) values = null;
    if (JSON.stringify(values).length > 40000) throw lcError('RANGE_TOO_LARGE', '单元格内容过多，请缩小读取范围');
    return { path: p.path, sheet: lcString(sheet.Name), address: p.address, values: values };
  }
  if (command.action === 'write_cell' && host === 'spreadsheet') {
    var targetSheet = typeof p.sheet === 'string' && p.sheet ? doc.Worksheets.Item(p.sheet) : doc.ActiveSheet;
    if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(p.address || '') || !['string', 'number', 'boolean'].includes(typeof p.value)) throw lcError('INVALID_CELL', '单元格或值无效');
    if (!lcSafeCellValue(p.value)) throw lcError('FORMULA_NOT_ALLOWED', '单元格值不允许包含可能执行的公式');
    if (!Object.prototype.hasOwnProperty.call(p, 'expectedValue')
        || (p.expectedValue !== null && !['string', 'number', 'boolean'].includes(typeof p.expectedValue))) {
      throw lcError('EXPECTED_VALUE_REQUIRED', '修改前需要先读取单元格，并提供预期值');
    }
    var prior = targetSheet.Range(p.address).Value2;
    if ((prior == null ? null : prior) !== (p.expectedValue == null ? null : p.expectedValue)) {
      throw lcError('CELL_CHANGED', '单元格已变化，请重新读取后再修改');
    }
    return lcMutation(function () {
      targetSheet.Range(p.address).Value2 = p.value;
      return { path: p.path, sheet: lcString(targetSheet.Name), address: p.address, value: targetSheet.Range(p.address).Value2, saved: false };
    });
  }
  if (command.action === 'list_slides' && host === 'presentation') {
    var slides = doc.Slides;
    return { path: p.path, totalSlides: lcCount(slides) };
  }
  if (command.action === 'read_slide' && host === 'presentation') {
    var slideNumber = Number(p.slide);
    if (!isFinite(slideNumber) || Math.floor(slideNumber) !== slideNumber || slideNumber < 1 || slideNumber > lcCount(doc.Slides)) throw lcError('INVALID_SLIDE', '幻灯片编号无效');
    var slide = doc.Slides.Item(slideNumber);
    var shapes = slide.Shapes;
    var texts = [];
    var shapeTotal = lcCount(shapes);
    var textLength = 0;
    var clipped = false;
    for (var index = 1; index <= Math.min(shapeTotal, 100); index++) {
      var shape = shapes.Item(index);
      try {
        if (shape.HasTextFrame) {
          var value = lcString(shape.TextFrame.TextRange.Text);
          if (value) {
            var remaining = 12000 - textLength;
            if (remaining <= 0) break;
            var excerpt = value.slice(0, Math.min(5000, remaining));
            if (excerpt.length < value.length) clipped = true;
            texts.push({ shape: index, text: excerpt });
            textLength += excerpt.length;
          }
        }
      } catch (_shapeError) {}
    }
    return { path: p.path, slide: slideNumber, shapeTotal: shapeTotal, textShapes: texts, truncated: clipped || shapeTotal > 100 || textLength >= 12000 };
  }
  if (command.action === 'add_slide' && host === 'presentation') {
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200
        || typeof p.subtitle !== 'string' || p.subtitle.length > 2000) throw lcError('INVALID_SLIDE', '新幻灯片内容无效');
    var position = lcCount(doc.Slides) + 1;
    var titleLayout = typeof ppLayoutTitle !== 'undefined' ? ppLayoutTitle : 1;
    return lcMutation(function () {
      var added = doc.Slides.Add(position, titleLayout);
      added.Shapes.Title.TextFrame.TextRange.Text = p.title;
      added.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = p.subtitle;
      if (lcString(added.Shapes.Title.TextFrame.TextRange.Text) !== p.title) throw lcError('WPS_WRITE_UNVERIFIED', '新幻灯片标题读回不一致');
      return { path: p.path, slide: position, title: p.title, totalSlides: lcCount(doc.Slides), saved: false };
    });
  }
  if (command.action === 'save') {
    return lcMutation(function () {
      doc.Save();
      return { path: p.path, saved: true };
    });
  }
  if (command.action === 'export_pdf') {
    if (!lcStagedOutput(p.output, 'pdf')) {
      throw lcError('INVALID_OUTPUT', 'PDF 输出路径不在本插件的本机暂存目录');
    }
    return lcMutation(function () {
      if (host === 'word') doc.ExportAsFixedFormat(p.output, 17);
      else if (host === 'spreadsheet') doc.ExportAsFixedFormat(0, p.output);
      else if (host === 'presentation') doc.ExportAsFixedFormat(p.output, 2);
      else throw lcError('HOST_UNAVAILABLE', 'WPS 组件暂不可用');
      return { path: p.path, exported: true, saved: false };
    });
  }
  throw lcError('UNSUPPORTED_ACTION', '当前 WPS 组件不支持此操作');
}

function lcSchedule(delay) {
  if (!LC_WPS_STARTED) return;
  if (LC_WPS_TIMER) clearTimeout(LC_WPS_TIMER);
  LC_WPS_TIMER = setTimeout(lcPoll, delay || 450);
}
function lcHeaders(xhr) {
  xhr.setRequestHeader('Authorization', 'Bearer ' + LC_WPS_CONFIG.token);
  xhr.setRequestHeader('X-LC-WPS-Instance', LC_WPS_INSTANCE);
  xhr.setRequestHeader('X-LC-WPS-Host', lcHost());
  if (LC_WPS_CONFIG.addonVersion) xhr.setRequestHeader('X-LC-WPS-Addon-Version', LC_WPS_CONFIG.addonVersion);
}
function lcSendAttempt(body, attempt) {
  function failed() {
    if (attempt < 3) { setTimeout(function () { lcSendAttempt(body, attempt + 1); }, 500); return; }
    LC_WPS_LAST = 'result delivery failed';
    LC_WPS_BUSY = false;
    lcSchedule(1500);
  }
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'http://127.0.0.1:' + LC_WPS_CONFIG.port + '/result', true);
    lcHeaders(xhr);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 5000;
    xhr.onload = function () {
      if (xhr.status !== 200 && xhr.status !== 409) { failed(); return; }
      LC_WPS_BUSY = false;
      lcSchedule(100);
    };
    xhr.onerror = failed;
    xhr.ontimeout = failed;
    xhr.send(body);
  } catch (_error) { failed(); }
}
function lcSend(command, ok, payload) {
  var body = JSON.stringify({ id: command.id, ok: ok, payload: payload, instance: LC_WPS_INSTANCE });
  lcSendAttempt(body, 1);
}
function lcPoll() {
  var host = lcHost();
  LC_WPS_LAST = 'poll host=' + host + ' started=' + LC_WPS_STARTED;
  if (!LC_WPS_STARTED || LC_WPS_BUSY || !host) { lcSchedule(1500); return; }
  var xhr;
  try { xhr = new XMLHttpRequest(); } catch (error) { LC_WPS_LAST = 'xhr=' + lcString(error.message); lcSchedule(1500); return; }
  xhr.open('GET', 'http://127.0.0.1:' + LC_WPS_CONFIG.port + '/next', true);
  lcHeaders(xhr);
  xhr.timeout = 4000;
  xhr.onload = function () {
    LC_WPS_LAST = 'poll status=' + xhr.status;
    if (xhr.status !== 200) { lcSchedule(xhr.status === 204 ? 450 : 1500); return; }
    var command;
    try { command = JSON.parse(xhr.responseText); } catch (_error) { lcSchedule(1500); return; }
    if (!command || typeof command.id !== 'string' || LC_WPS_SEEN.indexOf(command.id) >= 0) { lcSchedule(450); return; }
    LC_WPS_SEEN.push(command.id);
    if (LC_WPS_SEEN.length > 128) LC_WPS_SEEN.shift();
    LC_WPS_BUSY = true;
    try { lcSend(command, true, lcExecute(command)); }
    catch (error) { lcSend(command, false, { code: error.code || 'WPS_ACTION_FAILED', message: lcString(error.message).slice(0, 400) }); }
  };
  xhr.onerror = function () { LC_WPS_LAST = 'poll network error'; lcSchedule(1500); };
  xhr.ontimeout = xhr.onerror;
  xhr.send();
}
function OnAddinLoad() { LC_WPS_STARTED = true; lcSchedule(100); }
function OnStatusClick() {
  if (LC_WPS_LAST.indexOf('poll status=20') === 0) alert('LawyerCopilot 已连接到本机 WPS。');
  else alert('WPS 已打开，LawyerCopilot 正在连接；请稍后在对话中查看连接状态。');
}
LC_WPS_STARTED = true;
lcSchedule(250);
