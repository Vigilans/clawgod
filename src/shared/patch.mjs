#!/usr/bin/env node
/**
 * ClawGod Universal Patcher — 正则模式匹配, 跨版本兼容
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target');
if (targetIndex >= 0 && !args[targetIndex + 1]) {
  console.error('❌ --target requires an artifact directory');
  process.exit(1);
}
const artifactDir = targetIndex >= 0 ? args[targetIndex + 1] : __dirname;
const TARGET = join(artifactDir, 'cli.original.cjs');
const BACKUP = TARGET + '.bak';
const patchesFile = join(__dirname, 'patches.json');
const enabledCapabilities = existsSync(patchesFile)
  ? new Set(JSON.parse(readFileSync(patchesFile, 'utf8')).enabled)
  : null;

// ─── Regex-based patches (version-agnostic) ──────────────

const patches = [
  {
    // Let users define model aliases with
    // ANTHROPIC_DEFAULT_<ALIAS>_{MODEL,NAME,DESCRIPTION,SUPPORTED_CAPABILITIES}.
    // User, flag, and managed settings copy arbitrary env values into
    // process.env; project and local settings pass through an allowlist instead.
    // Extend that boundary so aliases work consistently from every settings scope.
    //
    // ≥2.1.218: settings env flows through a filter pipeline
    // (Gt_/jt_/Ut_/Kt_/Mt_/Ft_) and project/local scopes are written only via a
    // final allowlist gate:
    //   function BKt(e,t){let r=e.toUpperCase();return Rvh.has(r)||Lvh.has(r)&&Xt(t)}
    // Rvh hardcodes the four built-in aliases. Append the custom-alias regex to
    // the gate's return so project/local settings can set any alias.
    capability: 'features.custom-model-aliases',
    name: 'Allow custom alias env vars (BKt write gate, >=2.1.218)',
    pattern: /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{let ([\w$]+)=\2\.toUpperCase\(\);return ([\w$]+)\.has\(\4\)\|\|([\w$]+)\.has\(\4\)&&([\w$]+)\(\3\)\}/g,
    replacer: (m, fn, key, val, upper, allow, truthySet, truthyFn) =>
      `function ${fn}(${key},${val}){let ${upper}=${key}.toUpperCase();` +
      `return ${allow}.has(${upper})||${truthySet}.has(${upper})&&${truthyFn}(${val})` +
      `||/^ANTHROPIC_DEFAULT_[A-Z0-9_]+_(?:MODEL|NAME|DESCRIPTION|SUPPORTED_CAPABILITIES)$/.test(${upper})}`,
    optional: true,  // ≤2.1.217 used the allowlist loop below
  },
  {
    // ≤2.1.217: project/local settings env passed through a static allowlist
    // loop. Extend the same boundary there.
    //
    // Source shape:
    //   for(let[key,value]of Object.entries(env))
    //     if(allowed.has(key.toUpperCase())) process.env[key]=value
    capability: 'features.custom-model-aliases',
    name: 'Allow custom alias env vars (allowlist loop, <=2.1.217)',
    pattern: new RegExp(
      'for\\(let\\[([\\w$]+),([\\w$]+)\\]of Object\\.entries\\(([\\w$]+)\\)\\)' +
      'if\\(([\\w$]+)\\.has\\(\\1\\.toUpperCase\\(\\)\\)\\)' +
      'process\\.env\\[\\1\\]=\\2',
      'g'
    ),
    replacer: (m, key, value, entries, allowlist) => {
      const customAliasSetting =
        '/^ANTHROPIC_DEFAULT_[A-Z0-9_]+_' +
        '(?:MODEL|NAME|DESCRIPTION|SUPPORTED_CAPABILITIES)$/.test(' + key + '.toUpperCase())';
      return (
        `for(let[${key},${value}]of Object.entries(${entries}))` +
        `if(${allowlist}.has(${key}.toUpperCase())||${customAliasSetting})` +
        `process.env[${key}]=${value}`
      );
    },
    unique: true,
    optional: true,  // removed in v2.1.218+ (BKt gate above)
  },
  {
    // Discover ANTHROPIC_DEFAULT_<ALIAS>_MODEL keys, normalize each alias from
    // ENV_STYLE to kebab-case, and add it to the Agent tool's model enum so custom
    // aliases pass runtime input validation. Keep the built-in aliases unchanged.
    capability: 'features.custom-model-aliases',
    name: 'Extend Agent model schema with custom aliases',
    pattern: new RegExp(
      'model:([\\w$]+)\\.enum\\(\\["sonnet","opus","haiku","fable"\\]\\)' +
      '\\.optional\\(\\)\\.describe\\(`([^`]+)`\\)',
      'g'
    ),
    replacer: (m, schema, description) => {
      const envPrefix = 'ANTHROPIC_DEFAULT_';
      const envSuffix = '_MODEL';
      const aliasScan =
        'Object.keys(process.env)' +
        `.filter(function(k){return/^${envPrefix}[A-Z0-9_]+${envSuffix}$/.test(k)})` +
        `.map(function(k){return k.slice(${envPrefix.length},-${envSuffix.length})` +
        '.toLowerCase().replace(/_/g,"-")})' +
        '.filter(function(k){return!["sonnet","opus","haiku","fable"].includes(k)})';
      return (
        `model:${schema}.enum(["sonnet","opus","haiku","fable",...${aliasScan}])` +
        `.optional().describe(\`${description} ` +
        `Custom aliases are configured with ANTHROPIC_DEFAULT_<ALIAS>_MODEL.\`)`
      );
    },
    unique: true,
  },
  {
    // Add the same normalized aliases to the /model picker. Display the resolved
    // model ID while keeping the alias as the option value, and use the optional
    // ANTHROPIC_DEFAULT_<ALIAS>_NAME and _DESCRIPTION for its description.
    // Newer versions read the native custom option through the parsed env object;
    // older versions read process.env directly.
    capability: 'features.custom-model-aliases',
    name: 'Add custom aliases to model picker',
    pattern: new RegExp(
      'if\\(([\\w$]+)&&!([\\w$]+)\\.some\\(\\(([\\w$]+)\\)=>\\3\\.value===\\1\\)\\)' +
      '\\2\\.push\\(\\{value:\\1,' +
      'label:(?:process\\.env|[\\w$]+)\\.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME\\?\\?\\1,' +
      'description:(?:process\\.env|[\\w$]+)\\.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION\\?\\?' +
      '`Custom model \\(\\$\\{\\1\\}\\)`\\}\\);',
      'g'
    ),
    replacer: (m, customModel, options, option) => {
      const envPrefix = 'ANTHROPIC_DEFAULT_';
      const envSuffix = '_MODEL';
      const aliasScan =
        'Object.keys(process.env)' +
        `.filter(function(k){return/^${envPrefix}[A-Z0-9_]+${envSuffix}$/.test(k)})` +
        `.map(function(k){return k.slice(${envPrefix.length},-${envSuffix.length})` +
        '.toLowerCase().replace(/_/g,"-")})' +
        '.filter(function(k){return!["sonnet","opus","haiku","fable"].includes(k)})';
      const customOption =
        `if(${customModel}&&!${options}.some((${option})=>` +
        `${option}.value===${customModel}))${options}.push({` +
        `value:${customModel},` +
        `label:process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME??${customModel},` +
        `description:process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION??` +
        `\`Custom model (\${${customModel}})\`});`;
      const aliasOptions =
        `for(let _cgAlias of ${aliasScan})` +
        `if(!${options}.some((_cgOption)=>_cgOption.value===_cgAlias)){` +
        `let _cgAliasKey="ANTHROPIC_DEFAULT_"+` +
        `_cgAlias.toUpperCase().replace(/-/g,"_"),` +
        `_cgDefaultName=_cgAlias.charAt(0).toUpperCase()+_cgAlias.slice(1),` +
        `_cgAliasName=process.env[_cgAliasKey+"_NAME"]??_cgDefaultName;` +
        `${options}.push({value:_cgAlias,` +
        `label:process.env[_cgAliasKey+"_MODEL"],` +
        `description:process.env[_cgAliasKey+"_DESCRIPTION"]??` +
        `\`Custom \${_cgAliasName} model\`})}`;
      return customOption + aliasOptions;
    },
    unique: true,
  },
  {
    // Direct `/model <alias>` validates unknown names against the provider before
    // storing them. Configured aliases should follow the built-in alias path instead.
    capability: 'features.custom-model-aliases',
    name: 'Accept custom aliases in /model command',
    pattern: /if\(!([\w$]+)\|\|([\w$]+)\(\1\)\)return\{ok:!0,model:\1\};try\{/g,
    replacer: (m, model, builtInCheck) =>
      `if(!${model}||${builtInCheck}(${model})||` +
      `process.env["ANTHROPIC_DEFAULT_"+${model}.toUpperCase().trim()` +
      `.replace(/-/g,"_")+"_MODEL"])return{ok:!0,model:${model}};try{`,
    unique: true,
  },
  {
    // Resolve a selected custom alias to its ANTHROPIC_DEFAULT_<ALIAS>_MODEL value
    // before the native built-in-alias switch. Preserve a requested [1m] suffix,
    // but do not append it when the configured model ID already includes one.
    capability: 'features.custom-model-aliases',
    name: 'Resolve custom model aliases',
    pattern: new RegExp(
      'function ([\\w$]+)\\(([\\w$]+)\\)\\{' +
      'let ([\\w$]+)=\\2\\.trim\\(\\),([\\w$]+)=\\3\\.toLowerCase\\(\\),' +
      '([\\w$]+)=([\\w$]+)\\(\\4\\),' +
      '([\\w$]+)=\\5\\?([\\w$]+)\\(\\4\\)\\.trim\\(\\):\\4;' +
      'if\\(([\\w$]+)\\(\\7\\)\\)switch\\(\\7\\)\\{',
      'g'
    ),
    replacer: (m, fn, input, trimmed, lower, hasSuffix, suffixCheck, alias, stripSuffix, builtInCheck) => {
      const normalizedInput =
        `function ${fn}(${input}){let ${trimmed}=${input}.trim(),` +
        `${lower}=${trimmed}.toLowerCase(),` +
        `${hasSuffix}=${suffixCheck}(${lower}),` +
        `${alias}=${hasSuffix}?${stripSuffix}(${lower}).trim():${lower};`;
      const customAlias =
        `let _cgAliasKey="ANTHROPIC_DEFAULT_"+` +
        `${alias}.toUpperCase().replace(/-/g,"_")+"_MODEL",` +
        `_cgAliasModel=process.env[_cgAliasKey];` +
        `if(_cgAliasModel&&!${builtInCheck}(${alias}))` +
        `return ${hasSuffix}&&!${suffixCheck}(_cgAliasModel)` +
        `?_cgAliasModel+"[1m]":_cgAliasModel;`;
      const builtInAlias =
        `if(${builtInCheck}(${alias}))switch(${alias}){`;
      return normalizedInput + customAlias + builtInAlias;
    },
    unique: true,
  },
  {
    // The Agent model schema accepts aliases such as "fable", "opus", "sonnet",
    // and "haiku". A PreToolUse hook can replace one of those aliases with a
    // concrete model ID such as "gpt-5.6-sol", but the updatedInput validation
    // introduced in Claude Code 2.1.157 rejects that ID before the Agent runs.
    //
    // Keep the same validation for non-Agent tools. The stock diagnostic is absent
    // through 2.1.156 and is replaced below, so it also marks whether this source
    // path still needs the Agent-specific patch.
    capability: 'fixes.hook-update-agent-model',
    name: 'Bypass Agent PreToolUse updatedInput schema validation',
    pattern: new RegExp(
      'if\\(([\\w$]+)\\.updatedInput!==void 0\\)\\{' +
      'let ([\\w$]+)=([\\w$]+)\\.inputSchema\\.safeParse\\(\\1\\.updatedInput\\),' +
      '([\\w$]+)=\\2\\.success\\?\\[\\]:\\2\\.error\\.issues\\.filter\\(' +
      '\\(([\\w$]+)\\)=>\\5\\.code!=="unrecognized_keys"\\);' +
      'if\\(!\\2\\.success&&\\4\\.length>0\\)\\{' +
      'let ([\\w$]+)=new ([\\w$]+)\\.ZodError\\(\\4\\),' +
      '([\\w$]+)=`PreToolUse hook for \\$\\{\\3\\.name\\} returned updatedInput ' +
      'that failed schema validation: ',
      'g'
    ),
    replacer: (m, result, parsed, tool) =>
      m
        .replace(
          `if(${result}.updatedInput!==void 0){`,
          `if(${result}.updatedInput!==void 0&&${tool}.name!=="Agent"){`
        )
        .replace(
          `PreToolUse hook for \${${tool}.name} returned updatedInput that failed schema validation: `,
          `PreToolUse updated input for non-Agent tool \${${tool}.name} did not satisfy its input schema: `
        ),
    unique: true,
    sentinel: 'returned updatedInput that failed schema validation',
  },
  {
    // A second updatedInput validation path after permission handling first
    // appears in published Claude Code 2.1.193 and is absent through 2.1.191.
    // These ordered patches record both PreToolUse result forms, then skip the
    // later validation only when permission handling returns Agent input unchanged.
    // Non-Agent tools and independent PermissionRequest or canUseTool changes
    // retain their native validation.
    capability: 'fixes.hook-update-agent-model',
    name: 'Declare PreToolUse updatedInput origin marker',
    pattern: new RegExp(
      'let ([\\w$]+)=!1,([\\w$]+),([\\w$]+),([\\w$]+)=\\[\\],' +
      '([\\w$]+)=Date\\.now\\(\\);for await\\(let ([\\w$]+) of ([\\w$]+)\\(',
      'g'
    ),
    replacer: (m, stopped, stopReason, hookDecision, durations, startedAt, result, runHooks) =>
      `let ${stopped}=!1,${stopReason},${hookDecision},${durations}=[],` +
      `_cgHookInput,${startedAt}=Date.now();` +
      `for await(let ${result} of ${runHooks}(`,
    validate: (_, code) =>
      code.includes('The permission handler returned updatedInput for '),
    unique: true,
    sentinel: 'The permission handler returned updatedInput for ',
  },
  {
    capability: 'fixes.hook-update-agent-model',
    name: 'Record PreToolUse updatedInput origin',
    pattern: new RegExp(
      'case"hookPermissionResult":([\\w$]+)=([\\w$]+)\\.hookPermissionResult;' +
      'break;case"hookUpdatedInput":([\\w$]+)=\\2\\.updatedInput;' +
      'break;case"preventContinuation":',
      'g'
    ),
    replacer: (m, hookDecision, result, input) => {
      const permissionResult =
        `case"hookPermissionResult":${hookDecision}=${result}.hookPermissionResult;` +
        `${hookDecision}.updatedInput!==void 0&&` +
        `(_cgHookInput=${hookDecision}.updatedInput);break;`;
      const updatedInput =
        `case"hookUpdatedInput":_cgHookInput=${input}=${result}.updatedInput;` +
        'break;case"preventContinuation":';
      return permissionResult + updatedInput;
    },
    validate: (_, code) =>
      code.includes('The permission handler returned updatedInput for '),
    unique: true,
    sentinel: 'The permission handler returned updatedInput for ',
  },
  {
    capability: 'fixes.hook-update-agent-model',
    name: 'Skip later validation for unchanged Agent PreToolUse input',
    pattern: new RegExp(
      '([\\w$]+)\\.updatedInput!==void 0&&!([\\w$]+)\\(\\1\\.updatedInput\\)' +
      '(?=\\)\\{let [\\w$]+=[\\w$]+\\(([\\w$]+)\\.inputSchema,' +
      '\\1\\.updatedInput\\))([\\s\\S]{0,1200}?)' +
      'The permission handler returned updatedInput for ',
      'g'
    ),
    replacer: (m, decision, emptyInput, tool, suffix) => {
      const validateInput =
        `${decision}.updatedInput!==void 0&&` +
        `(${tool}.name!=="Agent"||_cgHookInput===void 0||` +
        `JSON.stringify(${decision}.updatedInput)!==JSON.stringify(_cgHookInput))&&` +
        `!${emptyInput}(${decision}.updatedInput)`;
      return (
        validateInput + suffix +
        'The permission handler supplied updatedInput for '
      );
    },
    unique: true,
    sentinel: 'The permission handler returned updatedInput for ',
  },
  {
    // Resuming a stopped Agent with SendMessage could change its model because the
    // model used at spawn time was not preserved through reconstruction.
    // https://github.com/anthropics/claude-code/issues/67794
    //
    // ≤2.1.210: Preserve the resolved spawn-time model here; the two patches below
    // restore it and pass it into the resumed query.
    //
    // ≥2.1.211: Claude Code fixes resume when the Agent call specified a model, but
    // still does not save a model inherited from frontmatter, global configuration,
    // the parent, or defaults. Preserve the resolved model so those Agents also resume
    // with the same model even if their configuration changes after they were spawned.
    capability: 'fixes.send-message-resume-model',
    name: 'Persist resolved Agent model in metadata',
    pattern: new RegExp(
      'async function\\*[\\w$]+\\(\\{agentDefinition:([\\w$]+),' +
      '[\\s\\S]{0,400}?toolUseContext:([\\w$]+),' +
      '[\\s\\S]{0,400}?model:([\\w$]+),' +
      '[\\s\\S]{0,1200}?\\}\\)\\{' +
      'let ([\\w$]+)=[\\w$]+\\(\\2\\),([\\w$]+)=\\4\\.mode,' +
      '[\\s\\S]{0,300}?([\\w$]+)=[\\w$]+\\(' +
      '[\\s\\S]{0,300}?,\\3,\\5,' +
      '[\\s\\S]{0,10000}?\\{agentType:\\1\\.agentType,(?!model:)',
      'g'
    ),
    replacer: (m, agentDefinition, toolContext, model, permissionContext, mode, resolvedModel) =>
      m.replace(
        `{agentType:${agentDefinition}.agentType,`,
        `{agentType:${agentDefinition}.agentType,model:${resolvedModel},`
      ),
    unique: true,
  },
  {
    // ≤2.1.210: SendMessage ignores the model saved at spawn when it chooses the
    // resumed Agent's model. Pass the saved model to the existing resolver.
    //
    // ≥2.1.211: Claude Code already passes the sidecar model to this resolver.
    // The old resume-query shape below is absent, so the existing sentinel check
    // reports native support instead of an unverifiable missing patch.
    capability: 'fixes.send-message-resume-model',
    name: 'Restore saved Agent model on resume',
    pattern: new RegExp(
      '([\\w$]+)\\?\\.isFork===void 0&&\\1\\?\\.agentType===' +
      '[\\w$]+\\.agentType,([\\w$]+)=[\\w$]+\\?\\?\\(' +
      '[\\w$]+\\?[\\w$]+:[\\w$]+\\),' +
      '[\\w$]+=\\1\\?\\.description\\?\\?"\\(resumed\\)"' +
      '[\\s\\S]{0,1600}?=[\\w$]+\\([\\w$]+\\(\\2,' +
      '([\\w$]+(?:\\.options\\.mainLoopModel)?)\\),\\3,' +
      'void 0,([\\w$]+)\\)',
      'g'
    ),
    replacer: (m, metadata, definition, parentModel, permissionMode) =>
      m.replace(
        `${parentModel},void 0,${permissionMode})`,
        `${parentModel},${metadata}?.isObserver?void 0:${metadata}?.model,${permissionMode})`
      ),
    unique: true,
    sentinel: 'spawnedBySkill:void 0,model:void 0,override:',
  },
  {
    // ≤2.1.210: SendMessage chooses the resumed Agent's task model but does not pass
    // it into the resumed query. Pass the saved model into that query as well.
    //
    // ≥2.1.211: Claude Code already passes the sidecar model into the resumed query.
    // The same sentinel check reports that native support.
    capability: 'fixes.send-message-resume-model',
    name: 'Pass saved model to resumed Agent query',
    pattern: new RegExp(
      '([\\w$]+)\\?\\.isFork===void 0&&\\1\\?\\.agentType===' +
      '[\\w$]+\\.agentType,[\\w$]+=[\\w$]+\\?\\?\\(' +
      '[\\w$]+\\?[\\w$]+:[\\w$]+\\),' +
      '[\\w$]+=\\1\\?\\.description\\?\\?"\\(resumed\\)"' +
      '[\\s\\S]{0,3000}?model:void 0,override:([\\w$]+)\\?',
      'g'
    ),
    replacer: (m, metadata, isFork) =>
      m.replace(
        'model:void 0,',
        `model:${metadata}?.isObserver?void 0:${metadata}?.model,`
      ),
    unique: true,
    sentinel: 'spawnedBySkill:void 0,model:void 0,override:',
  },
  {
    capability: 'features.anthropic-user-type',
    name: 'USER_TYPE → ant',
    pattern: /function ([\w$]+)\(\)\{return"external"\}/g,
    replacer: (m, fn) => `function ${fn}(){return"ant"}`,
    sentinel: 'return"external"',
  },
  {
    // Bun.isStandaloneExecutable is false under clawgod (plain Bun runtime,
    // not a compiled standalone binary). fv() guards daemon/fork spawn logic
    // (DLt), multitool dispatch (RS), and several other codepaths that need
    // to behave as if running the native binary. The property is frozen on
    // Bun 1.4+ (configurable:false, writable:false), so runtime monkey-patch
    // is impossible — patch the source instead. See issue #133.
    //
    // v2.1.236+ wraps the guard in a typeof-Bun check:
    //   function fv(){return Bun.isStandaloneExecutable===!0}        ≤v2.1.235
    //   function kw(){return typeof Bun<"u"&&Bun.isStandaloneExecutable===!0}  v2.1.236+
    // Match both via an optional `typeof Bun<"u"&&` prefix.
    name: 'Bun.isStandaloneExecutable → true',
    pattern: /function ([\w$]+)\(\)\{return (?:typeof Bun<"u"&&)?Bun\.isStandaloneExecutable===!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    capability: 'clawgod.features-config',
    name: 'GrowthBook env overrides',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\)=!0;return ([\w$]+)\}/g,
    replacer: (m, fn, flag, val) =>
      `function ${fn}(){if(!${flag}){${flag}=!0;try{let e=process.env.CLAUDE_INTERNAL_FC_OVERRIDES;if(e)${val}=JSON.parse(e)}catch(e){}}return ${val}}`,
    unique: true,  // must match exactly 1
  },
  {
    // v2.1.245+ moved env-override parsing into a GrowthBook class method and
    // introduced a dead-code bug: the lazy parse short-circuits on the second
    // return, so features.json (CLAUDE_INTERNAL_FC_OVERRIDES) never reaches the
    // feature store — tengu_prompt_cache_1h_config & friends silently lose effect.
    //
    // v2.1.246 shape (chunk graph, _668.js):
    //   getEnvironmentOverrides(){if(this.environmentOverridesParsed)return this.environmentOverrides;return this.environmentOverridesParsed=!0,this.environmentOverrides;let e=this.deps.readEnvironmentOverrides();if(!e)return this.environmentOverrides;try{this.environmentOverrides=Ce(e),p(`GrowthBook: Using env var overrides for ${...}`)}catch{p(`GrowthBook: Failed to parse CLAUDE_INTERNAL_FC_OVERRIDES: ${e}`,...)}return this.environmentOverrides}
    // Patch removes the short-circuit second return so the body reaches the
    // env-var read. Cross-version: match the lazy-parse idiom (flag=!0,value).
    capability: 'clawgod.features-config',
    name: 'GrowthBook env overrides (graph dead-code fix)',
    pattern: /return this\.environmentOverridesParsed=!0,this\.environmentOverrides;(?=let e=this\.deps\.readEnvironmentOverrides\(\);)/g,
    replacer: () => '',
    sentinel: 'environmentOverridesParsed=!0,this.environmentOverrides',
    optional: true,
  },
  {
    capability: 'clawgod.features-config',
    name: 'GrowthBook config overrides',
    pattern: /function ([\w$]+)\(\)\{return\}(function)/g,
    replacer: (m, fn, next) =>
      `function ${fn}(){return null}${next}`,
    selectIndex: 0,
    validate: (match, code) => {
      const pos = code.indexOf(match);
      const nearby = code.substring(Math.max(0, pos - 500), pos + 500);
      return nearby.includes('growthBook') || nearby.includes('GrowthBook') || nearby.includes('FeatureValue');
    },
  },
  {
    capability: 'features.agent-teams',
    name: 'Agent Teams always enabled',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\(process\.env\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\)&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    // v2.1.245+ Agent Teams gate became an exported module in its own chunk
    // with differently-minified identifiers. Shape (v2.1.246,_445.js):
    //   function i(){return process.argv.includes("--agent-teams")}
    //   function s(){if(!e.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&!i())return!1;if(!t("tengu_amber_flint",!0))return!1;return!0}
    // Match the flag-gate by the tengu_amber_flint + return!1 shape, tolerant
    // of the identifier set and the argv helper.
    capability: 'features.agent-teams',
    name: 'Agent Teams always enabled (graph)',
    pattern: /function ([\w$]+)\(\)\{if\(![\w$]+\.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&![\w$]+\(\)\)return!1;if\(![\w$]+\("tengu_amber_flint",!0\)\)return!1;return!0\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,
  },
  {
    capability: 'features.computer-use',
    name: 'Computer Use subscription bypass',
    pattern: /function ([\w$]+)\(\)\{let [\w$]+=[\w$]+\(\);return [\w$]+==="max"\|\|[\w$]+==="pro"\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    capability: 'features.computer-use',
    name: 'Computer Use default enabled',
    pattern: /([\w$]+=)\{enabled:!1,pixelValidation/g,
    replacer: (m, prefix) => `${prefix}{enabled:!0,pixelValidation`,
  },
  {
    // v2.1.92+ shape: name:"ultraplan",get description(){...},argumentHint:"<prompt>",isEnabled:()=>fnRef()
    // Older shape  : name:"ultraplan",description:`...`,argumentHint:"<prompt>",isEnabled:()=>!1
    // The middle metadata block changed from a literal description to a getter,
    // and the gate switched from a literal !1 to a GrowthBook-flag-check function call.
    // Match both.
    capability: 'features.ultraplan',
    name: 'Ultraplan enable',
    pattern: /(name:"ultraplan",[\s\S]{1,500}?argumentHint:"<prompt>",isEnabled:\(\)=>)(?:!1|[\w$]+\(\))/g,
    replacer: (m, prefix) => `${prefix}!0`,
    sentinel: 'name:"ultraplan"',
  },
  {
    // ≤v2.1.110: function X(){return Y("tengu_review_bughunter_config",null)?.enabled===!0}
    // v2.1.119+: function X(){return Y("tengu_review_bughunter_config",null)} — bare getter
    // v2.1.152+: same bare-getter shape, config also feeds cost_note/duration_note/model
    // v2.1.214+: config key moved to a variable:
    //   var Yau="tengu_review_bughunter_config";
    //   function Fot(){return et(Yau,null)}
    //   function rQt(){return Fot()?.enabled===!0&&ru()&&!J6()}
    //   Patch rQt to always return true so ultrareview is unlocked.
    //   Also match the old direct-literal form for <=2.1.213 compat.
    capability: 'features.ultrareview',
    name: 'Ultrareview enable (rQt gate)',
    pattern: /function ([\w$]+)\(\)\{return ([\w$]+)\(\)\?\.enabled===!0&&[\w$]+\(\)&&![\w$]+\(\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
    optional: true,
  },
  {
    capability: 'features.ultrareview',
    name: 'Ultrareview enable (direct literal, <=2.1.213)',
    pattern: /function ([\w$]+)\(\)\{return ([\w$]+)\("tengu_review_bughunter_config",null\)(\?\.enabled===!0)?\}/g,
    replacer: (m, fn, getter, gate) =>
      gate
        ? `function ${fn}(){return!0}`
        : `function ${fn}(){let _r=${getter}("tengu_review_bughunter_config",null);return _r?{..._r,enabled:!0}:{enabled:!0}}`,
    optional: true,
  },
  {
    capability: 'features.computer-use',
    name: 'Computer Use gate bypass',
    pattern: /function ([\w$]+)\(\)\{return [\w$]+\(\)&&[\w$]+\(\)\.enabled\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    capability: 'features.voice-mode',
    name: 'Voice Mode enable (bypass GrowthBook kill)',
    pattern: /function ([\w$]+)\(\)\{return![\w$]+\("tengu_amber_quartz_disabled",!1\)\}/g,
    replacer: (m, fn) => `function ${fn}(){return!0}`,
  },
  {
    // v2.1.158+: provider gate refactored into helper function:
    //   function mw$(H){if(H==="firstParty"||H==="anthropicAws")return!0;return CH(process.env.CLAUDE_CODE_ENABLE_AUTO_MODE)}
    //   Called as: if(!mw$(q))return!1;  inside the auto-mode model gate.
    //   Lookahead ensures we only strip the call inside the auto-mode gate
    //   (the next 300 chars must contain !=="firstParty") and not unrelated
    //   if(!fn(x))return!1; patterns elsewhere.
    //   Not present in ≤v2.1.149 (provider gate was inline).
    capability: 'features.auto-mode',
    name: 'Auto-mode unlock for third-party API (provider helper gate)',
    pattern: /if\(!([\w$]+)\(([\w$]+)\)\)return!1;(?=(?:(?!function\s).){0,300}!=="firstParty")/g,
    replacer: () => '',
    optional: true,
  },
  {
    // ≤v2.1.149: if(Y!=="firstParty"&&Y!=="anthropicAws")return!1;
    // v2.1.158+: if(q!=="firstParty"&&q!=="anthropicAws"&&($==="claude-opus-4-6"||…))return!1;
    // v2.1.214+: if(r!=="firstParty"&&!d6(r)&&(t==="claude-opus-4-6"||…))return!1;
    //   "anthropicAws" replaced by helper function !fn(var).
    //   Match both: \1!=="anthropicAws" OR !fn(\1).
    capability: 'features.auto-mode',
    name: 'Auto-mode unlock for third-party API (inline gate)',
    pattern: /if\(([\w$]+)!=="firstParty"&&(?:\1!=="anthropicAws"|![\w$]+\(\1\))[^;]*\)return!1;/g,
    replacer: () => '',
    sentinel: '!=="firstParty"&&',
  },
  {
    // CLI subcommand registered via commander chain:
    //   .command("update").alias("upgrade").description("…").action(async()=>{…})
    // The original action's update path is broken under clawgod: detectInstallType()
    // returns "unknown" because the launcher hides our cli.cjs from upstream's
    // path heuristics, and the unknown-fallback branch on macOS overwrites
    // ~/.bun/bin/bun by extracting the bun runtime out of the new native binary
    // (preserving Apr-19-build mtime). That **silently downgrades** clawgod's
    // required Bun and crashes cli.original.cjs the next launch with
    // "Expected CommonJS module to have a function wrapper". On Windows the
    // same fallback writes the new binary without replacing ClawGod's patched
    // source, so the user sees "Successfully updated" but never gets
    // the new version.
    //
    // Redirect to clawgod's own self-update so the upgrade goes through
    // install.sh (re-extract + re-patch + re-launcher). Always pull the
    // latest install.sh from the release so users get patcher fixes too.
    // Escape hatch printed on every run: `install.sh --uninstall` restores
    // claude.orig and lets vanilla `claude update` work again.
    //
    // v2.1.232+ wraps the action handler in a framework helper. The helper
    // is a minified identifier whose name drifts across builds:
    //   .action(async()=>{…})              ≤v2.1.231
    //   .action(t(async(a)=>{…}))          v2.1.232 … v2.1.237
    //   .action(n(async(u)=>{…}))          v2.1.238+
    // Match any one-letter minified helper via `identifier(` rather than
    // hardcoding a name, so a future rename keeps matching.
    capability: 'clawgod.update-command-redirect',
    name: "Redirect `claude update` to clawgod self-update",
    pattern: /(\.command\("update"\)\.alias\("upgrade"\)\.description\("[^"]+"\))(\.action\((?:[A-Za-z_$][\w$]*\()?async\([^)]*\)=>\{)/g,
    replacer: (m, chain, action) => {
      // PowerShell 5.1's Invoke-WebRequest ignores HTTP_PROXY/HTTPS_PROXY env
      // (only reads IE system proxy). Read env explicitly and pass via -Proxy
      // so it works on both PS 5.1 and PS 7. Use Invoke-RestMethod (irm) not
      // Invoke-WebRequest (iwr): under -UseBasicParsing on PS 5.1, iwr's
      // .Content is byte[] not string, so `iex (iwr -useb ...).Content`
      // throws "Cannot convert System.Byte[] to System.String". irm always
      // returns string in both versions. -EncodedCommand bypasses CLI
      // arg-quoting; payload must be UTF-16LE base64.
      const psScript =
        "$p=if($env:HTTPS_PROXY){$env:HTTPS_PROXY}elseif($env:HTTP_PROXY){$env:HTTP_PROXY}else{$null};" +
        "$u='https://github.com/0Chencc/clawgod/releases/latest/download/install.ps1';" +
        "if($p){iex(irm -Proxy $p $u)}else{iex(irm $u)}";
      const psB64 = Buffer.from(psScript, 'utf16le').toString('base64');
      return (
        chain + '.allowUnknownOption()' + action +
        `const _ui=process.argv.findIndex(a=>a==="update"||a==="upgrade");` +
        `const _ua=_ui>=0?process.argv.slice(_ui+1):[];` +
        `const _vi=_ua.indexOf("--version");` +
        `if(_vi>=0&&_ua[_vi+1])process.env.CLAWGOD_VERSION=_ua[_vi+1];` +
        `if(_ua.includes("--no-upgrade"))process.env.CLAWGOD_NO_UPGRADE="1";` +
        `if(_ua.includes("--lean-off"))process.env.CLAWGOD_LEAN_OFF="1";` +
        `if(_ua.includes("--lean-on"))process.env.CLAWGOD_LEAN_ON="1";` +
        `if(_ua.includes("--lean-max"))process.env.CLAWGOD_LEAN_MAX="1";` +
        `process.stderr.write("[clawgod] 'claude update' is handled by clawgod self-update.\\n[clawgod] To leave clawgod and use vanilla update: bash ~/.clawgod/install.sh --uninstall\\n[clawgod] Continuing now\\u2026\\n");` +
        `const _w=process.platform==='win32';` +
        `const _c=_w?['powershell','-NoProfile','-EncodedCommand','${psB64}']:['bash','-c','curl -fsSL https://raw.githubusercontent.com/Vigilans/clawgod/dev/install.sh | bash'];` +
        `const _r=require('child_process').spawnSync(_c[0],_c.slice(1),{stdio:'inherit',env:process.env});` +
        `process.exit(_r.status||0);`
      );
    },
    sentinel: '.command("update").alias("upgrade")',
  },
  // ── 绿色主题 (patch 标识) ──

  {
    capability: 'clawgod.green-theme',
    name: 'Logo + brand color → green (RGB dark)',
    pattern: /clawd_body:"rgb\(215,119,87\)"/g,
    replacer: () => 'clawd_body:"rgb(34,197,94)"',
  },
  {
    capability: 'clawgod.green-theme',
    name: 'Logo + brand color → green (ANSI)',
    pattern: /clawd_body:"ansi:redBright"/g,
    replacer: () => 'clawd_body:"ansi:greenBright"',
  },
  {
    capability: 'clawgod.green-theme',
    name: 'Theme claude color → green (dark)',
    pattern: /claude:"rgb\(215,119,87\)"/g,
    replacer: () => 'claude:"rgb(34,197,94)"',
  },
  {
    capability: 'clawgod.green-theme',
    name: 'Theme claude color → green (light)',
    pattern: /claude:"rgb\(255,153,51\)"/g,
    replacer: () => 'claude:"rgb(22,163,74)"',
  },
  {
    capability: 'clawgod.green-theme',
    name: 'Shimmer → green',
    pattern: /claudeShimmer:"rgb\(2[34]5,1[45]9,1[12]7\)"/g,
    replacer: () => 'claudeShimmer:"rgb(74,222,128)"',
  },
  {
    capability: 'clawgod.green-theme',
    name: 'Shimmer light → green',
    pattern: /claudeShimmer:"rgb\(255,183,101\)"/g,
    replacer: () => 'claudeShimmer:"rgb(34,197,94)"',
  },
  {
    capability: 'clawgod.green-theme',
    name: 'Hex brand color → green',
    pattern: /#da7756/g,
    replacer: () => '#22c55e',
  },
  {
    name: 'Theme claude color → green (ANSI)',
    pattern: /claude:"ansi:redBright"/g,
    replacer: () => 'claude:"ansi:greenBright"',
  },
  {
    name: 'Shimmer → green (ANSI)',
    pattern: /claudeShimmer:"ansi:yellowBright"/g,
    replacer: () => 'claudeShimmer:"ansi:greenBright"',
  },
  {
    name: 'Brief label claude color → green (RGB dark)',
    pattern: /briefLabelClaude:"rgb\(215,119,87\)"/g,
    replacer: () => 'briefLabelClaude:"rgb(34,197,94)"',
  },
  {
    name: 'Brief label claude color → green (RGB light)',
    pattern: /briefLabelClaude:"rgb\(255,153,51\)"/g,
    replacer: () => 'briefLabelClaude:"rgb(22,163,74)"',
  },
  {
    name: 'Brief label claude color → green (ANSI)',
    pattern: /briefLabelClaude:"ansi:redBright"/g,
    replacer: () => 'briefLabelClaude:"ansi:greenBright"',
  },

  // ── macOS Cmd+V 图片粘贴修复 ──

  {
    // Under Bun runtime (clawgod), macOS Cmd+V pastes the image file path
    // as text instead of triggering the clipboard image read. The paste
    // handler detects the path as an image file (gCc), tries to read it
    // via yCc, fails, and falls through to display the raw path as text.
    //
    // Fix: when all image path reads fail (L.length===0 && R.length>0)
    // and we're on macOS (d) with no other text (D.length===0), fall back
    // to the clipboard image reader (m()) — same path that Ctrl+V uses.
    //
    // Shape:
    //   if(L.length===0&&R.length>0)at("input_image_drag","read_failed"),D.push(...R)
    //
    // Patched:
    //   if(L.length===0&&R.length>0){at("input_image_drag","read_failed");if(d&&D.length===0){m();return}D.push(...R)}
    capability: 'fixes.macos-image-paste',
    name: 'macOS Cmd+V image paste fallback to clipboard read',
    pattern: /if\(([\w$]+)\.length===0&&([\w$]+)\.length>0\)([\w$]+)\("input_image_drag","read_failed"\),([\w$]+)\.push\(\.\.\.\2\)/g,
    replacer: (m, L, R, at, D) =>
      `if(${L}.length===0&&${R}.length>0){${at}("input_image_drag","read_failed");if(d&&${D}.length===0){m();return}${D}.push(...${R})}`,
    sentinel: '"input_image_drag","read_failed"',
    optional: true,
  },

  // ── Glob/Grep 工具恢复 ──

  {
    // Bun inlines EMBEDDED_SEARCH_TOOLS env as literal "true" at compile time.
    // This makes bC() always return true → Wft() returns the shadow set
    // containing "Glob" and "Grep" → those tools are hidden from the user.
    // Under clawgod (Bun runtime, not native binary) the env is unset, but
    // the code still says ct("true") instead of ct(process.env.EMBEDDED_SEARCH_TOOLS).
    //
    // Shape:
    //   function bC(){if(!ct("true"))return!1;if(mEr())return!1;
    //     return process.env.CLAUDE_CODE_ENTRYPOINT!=="local-agent"}
    //
    // Patch: replace ct("true") with ct(process.env.EMBEDDED_SEARCH_TOOLS)
    // so the guard reads the actual env var (unset → falsy → return false →
    // Glob/Grep tools available).
    name: 'Restore Glob/Grep tools (un-inline EMBEDDED_SEARCH_TOOLS)',
    pattern: /function ([\w$]+)\(\)\{if\(!([\w$]+)\("true"\)\)return!1;if\([\w$]+\(\)\)return!1;return process\.env\.CLAUDE_CODE_ENTRYPOINT!=="local-agent"\}/g,
    replacer: (m, fn, envCheck) =>
      `function ${fn}(){if(!${envCheck}(process.env.EMBEDDED_SEARCH_TOOLS))return!1;if(typeof globalThis.__dpBinOk>"u"){try{var _w=process.platform==="win32"?"where":"which";require("child_process").execFileSync(_w,["bfs"],{timeout:2e3});require("child_process").execFileSync(_w,["ugrep"],{timeout:2e3});globalThis.__dpBinOk=!0}catch{globalThis.__dpBinOk=!1}}if(!globalThis.__dpBinOk)return!1;return process.env.CLAUDE_CODE_ENTRYPOINT!=="local-agent"}`,
    sentinel: 'ct("true")',
    optional: true,
  },

  // ── 地区隐写中和 (v2.1.197+) ──

  {
    // v2.1.197+: geo-steganography in system prompt date string.
    // qla(e) builds "Today{apostrophe}s date is {date}." where:
    //   - the apostrophe encodes proxy-detection state (U+0027/U+2019/U+02BC/U+02B9)
    //   - the date separator encodes timezone (- for non-CN, / for CN)
    //
    // Shape:
    //   function qla(e){let t=rdp(),n=odp(t?.known??!1,t?.labKw??!1),
    //     r=t?.cnTZ?e.replaceAll("-","/"):e;return`Today${n}s date is ${r}.`}
    //
    // Patch: replace entire function body to always use ASCII apostrophe
    // and pass through the date string unmodified.
    capability: 'system-prompt.remove-geo-steganography',
    name: 'Neutralize geo-steganography in date string (qla)',
    pattern: /function ([\w$]+)\([\w$]+\)\{let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\([\w$]+\?\.[\w$]+\?\?!1,[\w$]+\?\.[\w$]+\?\?!1\),[\w$]+=[\w$]+\?\.[\w$]+\?[\w$]+\.replaceAll\("-","\/"\):[\w$]+;return`Today\$\{[\w$]+\}s date is \$\{[\w$]+\}\.`\}/g,
    replacer: (m) => {
      // Extract function name and parameter name from the match
      const fnMatch = m.match(/^function ([\w$]+)\(([\w$]+)\)/);
      if (!fnMatch) return m;
      const [, fn, param] = fnMatch;
      return `function ${fn}(${param}){return\`Today's date is \${${param}}.\`}`;
    },
    sentinel: 'replaceAll("-","/")',
  },
  {
    // v2.1.197+: rdp() performs three-axis geo detection:
    //   1. timezone === "Asia/Shanghai" || "Asia/Urumqi"  → cnTZ
    //   2. ANTHROPIC_BASE_URL hostname in XOR-obfuscated domain blocklist → known
    //   3. ANTHROPIC_BASE_URL contains CN-LLM vendor keywords → labKw
    //
    // Shape:
    //   function rdp(){if(vrt())return null;let e=ndp(),t=ekt(),
    //     n=t==="Asia/Shanghai"||t==="Asia/Urumqi";if(!e)return{known:!1,labKw:!1,cnTZ:n,host:null};
    //     return{known:edp().some(...),labKw:tdp().some(...),cnTZ:n,host:e}}
    //
    // Patch: always return null (same as firstParty path), disabling all detection.
    capability: 'system-prompt.remove-geo-steganography',
    name: 'Neutralize geo-detection probe (rdp)',
    pattern: /function ([\w$]+)\(\)\{if\([\w$]+\(\)\)return null;let [\w$]+=[\w$]+\(\),[\w$]+=[\w$]+\(\),[\w$]+=[\w$]+==="Asia\/Shanghai"\|\|[\w$]+==="Asia\/Urumqi"[\s\S]*?\}\}/g,
    replacer: (m) => {
      const fn = m.match(/^function ([\w$]+)/)[1];
      return `function ${fn}(){return null}`;
    },
    sentinel: 'Asia/Shanghai',
  },
  {
    // v2.1.197+: odp(known, labKw) selects a Unicode apostrophe to encode
    // proxy detection state into the system prompt:
    //   !known && !labKw → U+0027 (ASCII)
    //   known  && !labKw → U+2019 (RIGHT SINGLE QUOTATION MARK)
    //   !known && labKw  → U+02BC (MODIFIER LETTER APOSTROPHE)
    //   known  && labKw  → U+02B9 (MODIFIER LETTER PRIME)
    //
    // Shape:
    //   function odp(e,t){if(!e&&!t)return"'";if(e&&!t)return"'";
    //     if(!e&&t)return"ʼ";return"ʹ"}
    //
    // Patch: always return ASCII apostrophe regardless of detection state.
    // The return values may appear as \uXXXX escapes or literal UTF-8 in
    // the bundle depending on bundler version. Match both forms.
    // Defense-in-depth — qla patch above already bypasses the call to odp,
    // but if qla's shape changes this keeps odp harmless.
    capability: 'system-prompt.remove-geo-steganography',
    name: 'Neutralize apostrophe steganography (odp)',
    pattern: new RegExp(
      'function ([\\w$]+)\\(([\\w$]+),([\\w$]+)\\)\\{' +
      'if\\(!\\2&&!\\3\\)return"\'";' +
      'if\\(\\2&&!\\3\\)return"(?:\\\\u2019|\\u2019)";' +
      'if\\(!\\2&&\\3\\)return"(?:\\\\u02[Bb][Cc]|\\u02BC)";' +
      'return"(?:\\\\u02[Bb]9|\\u02B9)"\\}',
      'g'
    ),
    replacer: (m) => {
      const fn = m.match(/^function ([\w$]+)/)[1];
      return `function ${fn}(e,t){return"'"}`;
    },
    optional: true,  // defense-in-depth; rdp→null already neutralizes the stego channel
  },

  // ── 限制移除 ──

  {
    capability: 'system-prompt.remove-cyber-risk-instruction',
    name: 'Remove CYBER_RISK_INSTRUCTION',
    pattern: /([\w$]+)="IMPORTANT: Assist with authorized security testing[^"]*"/g,
    replacer: (m, varName) => `${varName}=""`,
    sentinel: 'Assist with authorized security testing',
  },
  {
    capability: 'system-prompt.remove-url-generation-restriction',
    name: 'Remove URL generation restriction',
    pattern: /\n\$\{[\w$]+\}\nIMPORTANT: You must NEVER generate or guess URLs[^.]*\. You may use URLs provided by the user in their messages or local files\./g,
    replacer: () => '',
    sentinel: 'IMPORTANT: You must NEVER generate or guess URLs',
  },
  {
    capability: 'system-prompt.remove-cautious-actions',
    name: 'Remove cautious actions section',
    // v2.1.88-~v2.1.122: function GSY(){return`# Executing actions...`}
    // v2.1.123+: function _j3(H){if(LE8(H)==="compact")return`# Executing...short`;return`# Executing...long`}
    pattern: /function ([\w$]+)\(([\w$]*)\)\{(?:if\([\s\S]{1,200}?\)return`# Executing actions with care\n\n[\s\S]*?`;)?return`# Executing actions with care\n\n[\s\S]*?`\}/g,
    replacer: (m, fn, arg) => `function ${fn}(${arg}){return\`\`}`,
    sentinel: '# Executing actions with care',
  },
  {
    capability: 'features.hide-login-notice',
    name: 'Remove "Not logged in" notice',
    pattern: /Not logged in\. Run [\w ]+ to authenticate\./g,
    replacer: () => '',
    optional: true,
  },

  // ── 消息过滤 ──

  {
    // v2.1.88-~v2.1.91: fn()!=="ant"){if(q.attachment.type==="hook_additional_context"...
    // v2.1.92+        : fn()!=="ant"&&paY.has(q.attachment.type) — paY is an empty Set
    //                    in v2.1.110, so this filter is effectively a no-op; patch anyway
    //                    to guard against paY being populated in future versions.
    capability: 'features.anthropic-user-type',
    name: 'Attachment filter bypass',
    pattern: /([\w$]+)\(\)!=="ant"(&&[\w$]+\.has\([\w$]+\.attachment\.type\)|\)\{if\([\w$]+\.attachment\.type==="hook_additional_context")/g,
    replacer: (m) => m.replace(/([\w$]+)\(\)!=="ant"/, 'false'),
    optional: true,  // filter may be removed entirely in future versions
  },
  {
    // Legacy (≤v2.1.91) ternary form: fn()!=="ant"?tRY(_,sRY(K)):K
    capability: 'features.anthropic-user-type',
    name: 'Message list filter bypass (legacy ternary)',
    pattern: /([\w$]+)\(\)!=="ant"\?([\w$]+)\(([\w$]+),([\w$]+)\(([\w$]+)\)\):([\w$]+)/g,
    replacer: (m, fn, tRY, underscore, sRY, K, fallback) => fallback,
    optional: true,  // removed in v2.1.92+
  },
  {
    // v2.1.92+ (s_8): if(fn()==="ant")return _;let z=...;return FaY(_,z)
    // Flip the guard so non-ant users also return the pre-filtered list.
    capability: 'features.anthropic-user-type',
    name: 'Message list filter bypass (s_8 form)',
    pattern: /if\(([\w$]+)\(\)==="ant"\)return ([\w$]+);let ([\w$]+)=([\w$]+) instanceof Set\?\4:([\w$]+)\(\4\);return ([\w$]+)\(\2,\3\)/g,
    replacer: (m, fn, ret) => `return ${ret}`,
    optional: true,  // legacy versions had a ternary instead
  },
  {
    // Shell-integration generator (iT6 in v2.1.140, was Wa1 in older versions)
    // emits a zsh/bash function that calls the native claude binary with
    // ARGV0=ugrep|rg|... for multitool dispatch. After clawgod installs, the
    // baked path points at our shell-script launcher — but shell scripts
    // CANNOT preserve argv[0] (kernel shebang re-exec overwrites it, and zsh
    // additionally refuses to export ARGV0 as env). The shell function then
    // fails because bun receives e.g. -G and errors with "Invalid Argument".
    //
    // Fix: redirect the baked path to claude.orig (the native binary backup
    // clawgod creates at install time). Then the multitool dispatch reaches
    // a real binary that honors argv[0]. See issue #82.
    //
    // Generator shape across versions:
    //   v2.1.88 (Wa1):  let Y=E4([_]),...  ← _ is the claude binary path, no in-function compute
    //   v2.1.140 (iT6): let ...,z=FJ$.join(Le(),A?"claude.exe":"claude"),Y=A?rL(z):z,...
    //                   ← path computed inside via join(versionsDir, "claude[.exe]")
    // Anchor on the join(...) ternary form unique to the generator — the
    // bare "claude.exe":"claude" string also appears in u18() (basename
    // helper) but never inside a path.join(), so this regex hits exactly the
    // shell-integration generator and nothing else.
    name: 'Shell integration → claude.orig (multitool dispatch fix)',
    pattern: /([\w$]+\.join\([\w$]+\(\),[\w$]+\?)"claude\.exe":"claude"(\))/g,
    replacer: (m, prefix, suffix) => `${prefix}"claude.orig.exe":"claude.orig"${suffix}`,
    sentinel: '?"claude.exe":"claude")',
    optional: true,  // v2.1.88-era bundles compute the path differently
  },
];

// ─── Main ─────────────────────────────────────────────────

// cli.original path (legacy single-bundle) or graph dir (v2.1.245+)
const dryRun = args.includes('--dry-run');
const verify = args.includes('--verify');
const revert = args.includes('--revert');

const GRAPH_DIR = join(artifactDir, 'bunfs');
const isGraph = existsSync(GRAPH_DIR);

if (revert) {
  if (isGraph) {
    // graph: restore each file from its .bak (no-op if none) — full graph
    // backup isn't taken for chunks; only the entry has a .bak. Re-extract
    // instead: the safest revert for graph installs is to rerun extract.
    console.log('⚠️  Graph install detected — run install.sh to re-extract clean source.');
    process.exit(0);
  }
  if (!existsSync(BACKUP)) { console.error('❌ No backup found'); process.exit(1); }
  copyFileSync(BACKUP, TARGET);
  console.log('✅ Reverted from backup');
  process.exit(0);
}

// ── Load target(s) ─────────────────────────────
// isGraph: files = { 'cli.original.cjs': '...', 'bunfs/_444.js': '...', ... }
// else:    files = { 'cli.original.cjs': '...' }
let files = {};
if (isGraph) {
  files[TARGET] = readFileSync(TARGET, 'utf8');
  for (const f of readdirSync(GRAPH_DIR)) {
    if (!/\.js$/.test(f) && !/\.mjs$/.test(f)) continue;
    files[join(GRAPH_DIR, f)] = readFileSync(join(GRAPH_DIR, f), 'utf8');
  }
} else {
  if (!existsSync(TARGET)) {
    console.error('❌ Target not found:', TARGET);
    process.exit(1);
  }
  files[TARGET] = readFileSync(TARGET, 'utf8');
}

// Extract version from entry content
const version = (files[TARGET] || '').match(/Version:\s*([\d.]+)/)?.[1] || 'unknown';
const isCJSBundle = !isGraph; // legacy

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ClawGod (universal)`);
console.log(`  Target: ${TARGET} (v${version}) ${isGraph ? `[graph: ${Object.keys(files).length} files]` : ''}`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : verify ? 'VERIFY' : 'APPLY'}`);
console.log(`${'═'.repeat(55)}\n`);

// unified search: gather all matches of a pattern across every loaded file.
// validate() receives the full file text so surrounding-context patterns keep working.
function collectMatches(p) {
  const out = []; // { file, match, matches }
  for (const [fname, content] of Object.entries(files)) {
    const matches = [...content.matchAll(p.pattern)];
    if (matches.length === 0) continue;
    let rel = matches;
    // per-file validate / selectIndex — but these were designed for a single
    // bundle string. For graph, the pattern is applied per file, so each file
    // is an independent unit. validate() sees that file's content.
    if (p.validate) rel = matches.filter((m) => p.validate(m[0], content));
    out.push({ file: fname, content, matches: rel });
  }
  return out;
}

let applied = 0, skipped = 0, disabled = 0, failed = 0;

for (const p of patches) {
  if (p.capability && enabledCapabilities !== null && !enabledCapabilities.has(p.capability)) {
    console.log(`  ⏸  ${p.name} (${p.capability} disabled)`);
    disabled++;
    continue;
  }

  const fileMatches = collectMatches(p);

  /*
   * Patch semantics per file:
   *  - If a file contains match(es), apply replacement to that file.
   *  - "unique" / "validate" / "selectIndex" still constrain within one file.
   *  - The overall patch reports applied once if ANY file changed.
   *  - The "already applied / sentinel / stale" logic: if NO file has any
   *    match, fall through to the sentinel-based diagnostics (same as legacy).
   */
  let fileChangedCount = 0;
  const relevantFiles = fileMatches.filter((fm) => fm.matches.length > 0);

  // unique: if the aggregated count is >1 *across files* but the pattern
  // should hit exactly once in the whole app, we only allow applying to a
  // single file. Legacy enforced uniqueness over the whole bundle string;
  // graph splits it per-file so each file normally has ≤1 match anyway.
  let totalMatches = 0;
  for (const fm of fileMatches) totalMatches += fm.matches.length;

  if (relevantFiles.length === 0) {
    if (p.optional) {
      console.log(`  ⏭  ${p.name} (not present in this version)`);
      skipped++;
      continue;
    }
    if (p.sentinel !== undefined) {
      const sentinels = Array.isArray(p.sentinel) ? p.sentinel : [p.sentinel];
      const stillPresent = sentinels.filter((s) => Object.values(files).some((c) => c.includes(s)));
      if (stillPresent.length > 0) {
        console.log(`  ❌ ${p.name} — regex stale, sentinel still in source: ${stillPresent.map((s) => JSON.stringify(s)).join(', ')}`);
        failed++;
        continue;
      }
      console.log(`  ✅ ${p.name} (already applied, sentinel absent)`);
      applied++;
      continue;
    }
    console.log(`  ⚠️  ${p.name} (0 matches, no sentinel — cannot verify)`);
    skipped++;
    continue;
  }

  if (verify) {
    console.log(`  ⬚  ${p.name} — ${totalMatches} match(es), not yet applied`);
    skipped++;
    continue;
  }

  // Apply per file. For "unique" patches that would match in multiple files,
  // only apply to the first (they are expected to be single-site).
  const uniqueLimit = p.unique ? 1 : Infinity;
  let appliedFiles = 0;
  for (const fm of relevantFiles) {
    if (appliedFiles >= uniqueLimit) break;
    let changed = false;
    let count = 0;
    for (const m of fm.matches) {
      const replacement = p.replacer(m[0], ...m.slice(1));
      if (replacement !== m[0]) {
        if (!dryRun) {
          files[fm.file] = files[fm.file].replace(m[0], () => replacement);
        } else {
          // in dry-run mutate the local copy only for counting
          const tmp = fm.content;
          files[fm.file] = tmp.replace(m[0], () => replacement);
        }
        changed = true;
        count++;
      }
    }
    if (changed) appliedFiles++;
    fileChangedCount += count;
  }

  if (fileChangedCount > 0) {
    console.log(`  ✅ ${p.name} (${fileChangedCount} replacement${fileChangedCount > 1 ? 's' : ''} in ${appliedFiles} file${appliedFiles > 1 ? 's' : ''})`);
    applied++;
  } else if (relevantFiles.length > 0) {
    console.log(`  ⏭  ${p.name} (no change needed)`);
    skipped++;
  }
}

console.log(`\n${'─'.repeat(55)}`);
console.log(`  Result: ${applied} applied, ${skipped} skipped, ${disabled} disabled, ${failed} failed`);

if (!dryRun && !verify && failed === 0 && applied > 0) {
  // backup the entry (legacy semantics); graph writes all files in place
  if (!existsSync(BACKUP)) {
    copyFileSync(TARGET, BACKUP);
    console.log(`  📦 Backup: ${BACKUP}`);
  }
  for (const [fname, content] of Object.entries(files)) {
    writeFileSync(fname, content, 'utf8');
  }
  const origSize = isGraph ? 0 : (readFileSync(BACKUP, 'utf8').length || 0);
  console.log(`  📝 Written: ${Object.keys(files).length} file(s) ${isGraph ? '(graph)' : ''}`);
}

console.log(`${'═'.repeat(55)}\n`);
if (failed > 0) process.exit(1);
