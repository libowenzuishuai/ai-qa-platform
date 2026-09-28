"""Deterministic test generation from reviewed examples, without consulting implementation outputs."""
import hashlib
import json
import re
from ..errors import ServiceError
from ..contracts import generated as models


def generate(data: dict) -> dict:
    rules = {r['id']: r for r in data['rules']}
    examples = data['examples']
    if any(r['reviewStatus'] != 'APPROVED' for r in rules.values()):
        raise ServiceError('VALIDATION_ERROR', '生成测试只能使用批准规则')
    if any(e['ruleVersionId'] not in rules for e in examples):
        raise ServiceError('VALIDATION_ERROR', '测试样例引用了未批准规则')
    if len({e['id'] for e in examples}) != len(examples):
        raise ServiceError('VALIDATION_ERROR', '样例 ID 重复')
    module, function = data['modulePath'], data['functionName']
    if '..' in module.split('/') or not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_./-]*', module) or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', function):
        raise ServiceError('VALIDATION_ERROR', '模块或函数名不合法')
    if data['language'] == 'node':
        if not module.endswith(('.js', '.mjs', '.cjs')):
            raise ServiceError('VALIDATION_ERROR', 'Node 候选测试需要可直接导入的 JS 模块')
        lines = ['// Generated from approved examples. Expected values are independent of implementation.',
                 "import test from 'node:test';", "import assert from 'node:assert/strict';",
                 f'import * as subject from {json.dumps("../" + module)};']
        for e in examples:
            title = json.dumps('AIQA:' + e['id'] + ':' + e['ruleVersionId'], ensure_ascii=True)
            args = ', '.join(json.dumps(a, ensure_ascii=True, allow_nan=False) for a in e['args'])
            expected = json.dumps(e['expected'], ensure_ascii=True, allow_nan=False)
            lines.append(f'test({title}, async () => {{ const actual = await subject[{json.dumps(function)}]({args}); assert.deepStrictEqual(actual, {expected}, {json.dumps("AIQA_ASSERTION:" + e["id"])}); }});')
        path = 'aiqa_generated_tests/approved.test.mjs'
    else:
        if not module.endswith('.py') or not all(re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', part) for part in module[:-3].split('/')):
            raise ServiceError('VALIDATION_ERROR', 'Python 候选测试需要可导入的模块路径')
        lines = ['# Generated from approved examples; no source-output oracle.', 'import importlib', 'import json', 'import unittest',
                 f'subject = importlib.import_module({module[:-3].replace("/", ".")!r})', 'def _kind(value):', '    if isinstance(value, bool): return \"boolean\"', '    if isinstance(value, (int, float)): return \"number\"', '    return type(value).__name__', 'class ApprovedExamples(unittest.TestCase):']
        for i, e in enumerate(examples):
            encoded = repr(json.dumps({'args': e['args'], 'expected': e['expected']}, ensure_ascii=True, allow_nan=False))
            lines += [f'    def test_aiqa_{i}(self):', f'        example = json.loads({encoded})',
                      f'        actual = getattr(subject, {function!r})(*example["args"])', f'        self.assertEqual(_kind(actual), _kind(example["expected"]), {("AIQA_ASSERTION:" + e["id"])!r})', f'        self.assertEqual(actual, example["expected"], {("AIQA_ASSERTION:" + e["id"])!r})']
        path = 'aiqa_generated_tests/test_approved.py'
    content = '\n'.join(lines) + '\n'
    return {'generatorVersion': 'approved-examples-v1', 'files': [{'path': path, 'content': content, 'contentHash': hashlib.sha256(content.encode()).hexdigest()}],
            'exampleIds': [e['id'] for e in examples], 'limitations': ['仅覆盖输入的批准样例，不证明规格完整', '支持具名导出的函数与 JSON 基础值；Python 异步函数暂不支持', '未执行前不能标记有效；需要健康、缺陷、修复对照']}


async def propose(typed_input, context):
    return models.CandidateTestsOutput.model_validate(generate(typed_input.model_dump(mode='json')))
