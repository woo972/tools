/**
 * MCP stdio 어댑터 (스펙 §4.10).
 *
 * 데몬에 UDS로 붙는 얇은 어댑터다. 상태를 갖지 않고 정책 판정도 하지 않는다 —
 * 두 클라이언트(Claude Code / Codex)가 세션마다 이 프로세스를 새로 띄우기 때문에
 * 기동 비용이 낮아야 하고, 판정이 여기 있으면 데몬과 어긋난다.
 *
 * 크래시하지 않는 게 계약이다: Claude Code는 stdio 서버가 죽어도 자동 재시작하지
 * 않는다. 데몬이 꺼져 있어도 프로세스는 살아남아 tool 결과로 명확한 에러를 돌려준다.
 */

import { createInterface } from 'node:readline';
import { toDevkitError } from '#core/errors.ts';
import { call, callOrThrow } from './client.ts';
import { DEFAULT_ENV } from './api.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'config-provider', version: '0.1.0' };

/**
 * Codex는 이 문자열을 서버 전역 지침으로 쓰고, 앞 512자가 자체 완결적이길 권고한다.
 * 그래서 가장 중요한 두 규칙(2단계 조회, 값 출력 금지)을 맨 앞에 둔다.
 */
const INSTRUCTIONS = [
  '소유자의 개인 설정 저장소입니다. 서버 주소·비밀번호·API 키·도메인 용어(카프카 토픽명 등)를 조회합니다.',
  '규칙 1: 값이 필요하면 먼저 resolve_alias로 key를 확인한 뒤 get_value를 부르세요. key를 추측하지 마세요.',
  '규칙 2: get_value가 돌려준 값은 대화 컨텍스트와 로그에 남습니다. 화면에 그대로 출력하지 말고 필요한 명령에만 쓰세요.',
  '규칙 3: status가 "unset"이면 값이 아직 없는 것이니 사람에게 물어보세요. KEY_NOT_FOUND는 key를 잘못 안 것이니 다시 검색하세요.',
  '규칙 4: POLICY_DENIED는 소유자가 의도적으로 막은 것입니다. 우회하지 말고 사람에게 허용을 요청하세요.',
].join(' ');

const TOOLS = [
  {
    name: 'resolve_alias',
    description:
      '자연어 표현으로 설정 항목의 key를 찾습니다. 값은 반환하지 않고 메타데이터(key, 설명, 리소스 종류, 민감도)만 돌려줍니다.\n\n' +
      '언제 쓰는가: "입고지시 토픽 이름이 뭐지", "주문 DB 접속 정보" 처럼 이름이 기억나지 않을 때. ' +
      '값 조회 전에 항상 먼저 부르세요.\n' +
      '언제 안 쓰는가: 이미 정확한 key를 아는 경우.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '자연어 검색어 (예: "입고지시", "주문 DB 비밀번호")' },
        limit: { type: 'integer', description: '최대 결과 수 (기본 10)', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: '용어 검색', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_value',
    description:
      '⚠️ 반환된 값은 이 대화의 컨텍스트와 로그에 그대로 남습니다. 정말 값 자체가 필요할 때만 부르세요 — ' +
      '명령만 실행하면 되는 경우라면 소유자에게 환경변수 주입 방식을 요청하는 편이 안전합니다.\n\n' +
      '설정 항목의 실제 값을 조회합니다. env를 생략하면 dev입니다. prod는 항상 명시적으로 지정해야 합니다.\n' +
      '응답의 status: "ok"(값 있음) / "unset"(항목은 있으나 값 미설정 → 사람에게 문의). ' +
      '없는 key는 KEY_NOT_FOUND 에러입니다.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'resolve_alias로 확인한 정확한 key' },
        env: { type: 'string', description: 'prod 또는 dev. 생략 시 dev', enum: ['prod', 'dev'] },
      },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: { title: '값 조회', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'add_alias',
    description:
      '기존 항목에 자연어 별칭을 추가합니다. 값에는 접근하지 않으며, key나 값은 이 도구로 만들거나 바꿀 수 없습니다.\n\n' +
      '언제 쓰는가: 대화 중 "이 토픽을 앞으로 이렇게 부르자"가 정해졌을 때, 다음 세션의 자신이 찾을 수 있게 기록해 둘 때.\n' +
      '이미 다른 항목이 쓰는 별칭이면 ALIAS_CONFLICT로 거부됩니다 — 다른 표현을 고르세요.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '별칭을 붙일 기존 항목의 key' },
        alias: { type: 'string', description: '추가할 자연어 별칭' },
      },
      required: ['key', 'alias'],
      additionalProperties: false,
    },
    annotations: { title: '별칭 추가', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

type Request = { jsonrpc: '2.0'; id?: string | number; method: string; params?: any };

export async function serve(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    void handleLine(line);
  });
  await new Promise<void>((resolve) => rl.on('close', resolve));
}

async function handleLine(line: string): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (req.id === undefined) return; // 알림에는 응답하지 않는다

  try {
    send({ jsonrpc: '2.0', id: req.id, result: await dispatch(req) });
  } catch (err) {
    const e = toDevkitError(err);
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e.message, data: e.toJSON() } });
  }
}

async function dispatch(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return await callTool(req.params?.name, req.params?.arguments ?? {}, req.params?._meta);
    default:
      return {};
  }
}

async function callTool(name: string, args: any, meta?: Record<string, unknown>): Promise<unknown> {
  const agentId =
    (typeof meta?.agentId === 'string' && meta.agentId) || process.env.DKC_AGENT_ID || 'mcp';

  try {
    switch (name) {
      case 'resolve_alias': {
        const data = await get('/alias/search', { q: String(args.query ?? ''), limit: args.limit ? String(args.limit) : undefined }, agentId);
        return textResult({
          hits: data.hits,
          note: data.hits?.length
            ? '값을 얻으려면 get_value(key)를 부르세요. visibility가 secret이면 정책상 거부될 수 있습니다.'
            : '일치하는 항목이 없습니다. 다른 표현으로 다시 검색하거나 사람에게 물어보세요.',
        });
      }
      case 'get_value': {
        const data = await get(`/config/${encodeURIComponent(String(args.key ?? ''))}`, { env: args.env ?? DEFAULT_ENV }, agentId);
        return textResult({
          key: data.key,
          env: data.env,
          status: data.status,
          value: data.value,
          visibility: data.visibility,
          note: data.status === 'unset'
            ? '항목은 정의되어 있으나 이 env의 값이 아직 없습니다. 추측하지 말고 사람에게 물어보세요.'
            : '이 값은 대화 컨텍스트에 남았습니다. 재출력하지 마세요.',
        });
      }
      case 'add_alias': {
        const r = await call(`/alias/${encodeURIComponent(String(args.key ?? ''))}`, {
          method: 'POST',
          body: { alias: args.alias },
          caller: 'agent',
          agentId,
        });
        if (!r.body?.ok) return errorResult(r.body?.error);
        return textResult({ key: r.body.data.key, alias: r.body.data.alias, changed: r.body.data.changed });
      }
      default:
        return errorResult({ code: 'TOOL_NOT_FOUND', message: `알 수 없는 도구: ${name}`, retryable: false });
    }
  } catch (err) {
    // 데몬이 꺼져 있어도 프로세스를 죽이지 않는다. 에이전트가 hint를 보고 사람에게 요청할 수 있게.
    return errorResult(toDevkitError(err).toJSON());
  }
}

/**
 * 데몬 응답을 그대로 통과시킨다.
 * toDevkitError로 감싸면 hint와 fixCommand가 "예상하지 못한 예외입니다"로 덮여
 * 에이전트가 스스로 복구할 단서를 잃는다 — callOrThrow는 페이로드를 보존한다.
 */
async function get(path: string, query: Record<string, string | undefined>, agentId: string): Promise<any> {
  return await callOrThrow(path, { query, caller: 'agent', agentId });
}

function textResult(payload: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: false };
}

function errorResult(error: unknown): unknown {
  const body = { ok: false, error };
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: true };
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

if (import.meta.filename === process.argv[1]) {
  serve().catch((err) => {
    process.stderr.write(`config-provider MCP 시작 실패: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
