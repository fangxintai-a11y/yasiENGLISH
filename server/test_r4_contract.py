"""R4 optional attempt fields, shared synthetic wire fixture, real temporary SQLite."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
try:
    from .app import Database
    from .learning import LearningError, LearningStore, content_hash, encoded, validate_payload
except ImportError:
    from app import Database
    from learning import LearningError, LearningStore, content_hash, encoded, validate_payload
FIXTURE = json.loads((Path(__file__).resolve().parents[1] / 'src/study365/fixtures/r4-records.json').read_text())
def record(record_id):
    return next(item for item in FIXTURE['records'] if item['recordId'] == record_id)
def invalid_payload(case):
    value=copy.deepcopy(record(case['recordId'])['request']['payload']); target=value
    for key in case['path'][:-1]: target=target[key]
    if case.get('remove'): del target[case['path'][-1]]
    else: target[case['path'][-1]]=case['value']
    return value
class R4ContractTest(unittest.TestCase):
    def test_reopen_replay_preserves_raw_payloads_revision_hashes_and_receipts(self):
        with tempfile.TemporaryDirectory(prefix='band-r4-contract-') as directory:
            database=Database(Path(directory)/'learning.sqlite3')
            with database.connect() as db:
                db.execute('INSERT INTO users VALUES(?,?,?,?)',('r4-test-user','r4-test-user','unused-test-hash',1))
            store=LearningStore(database); responses={}
            for item in FIXTURE['records']:
                result=store.put('r4-test-user',item['recordId'],item['request'])
                self.assertEqual(result[0],200); self.assertEqual(result[1]['record']['payload'],item['request']['payload'])
                self.assertEqual(result[1]['record']['contentHash'],item['expectedContentHash']); responses[item['request']['mutationId']]=result
            with database.connect() as db:
                rows=[tuple(row) for row in db.execute('SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq')]
                receipts=[tuple(row) for row in db.execute('SELECT * FROM learning_mutation_receipts ORDER BY mutation_id')]
                self.assertEqual(db.execute('SELECT count(*) FROM snapshots').fetchone()[0],0)
            reopened=LearningStore(Database(database.path))
            for item in FIXTURE['records']: self.assertEqual(reopened.put('r4-test-user',item['recordId'],item['request']),responses[item['request']['mutationId']])
            actual=reopened.list('r4-test-user')['items']; self.assertEqual(len(actual),len(FIXTURE['records']))
            for value,item in zip(actual,FIXTURE['records']): self.assertEqual(value['payload'],item['request']['payload'])
            old=next(item for item in actual if item['id']=='r4-legacy-attempt'); self.assertNotIn('materialSource',old['payload']); self.assertNotIn('coverage',old['payload'])
            with database.connect() as db:
                self.assertEqual(rows,[tuple(row) for row in db.execute('SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq')])
                self.assertEqual(receipts,[tuple(row) for row in db.execute('SELECT * FROM learning_mutation_receipts ORDER BY mutation_id')])
                self.assertEqual([row[0] for row in db.execute('SELECT version FROM learning_schema_migrations ORDER BY version')],[1,2])
    def test_coverage_accepts_exactly_fifty_targets_without_rewriting_partition(self):
        ids=[f'w-{n}' for n in range(50)]
        value={**BASE,'coverage':{'requestedWordIds':ids,'coveredWordIds':ids[:20],'uncoveredWordIds':ids[20:],'matcherVersion':'r4-v1'}}
        before=copy.deepcopy(value); validate_payload('attempt',value,'r4-boundary'); self.assertEqual(value,before)
    def test_review_preserves_original_answers_and_score_while_revision_hash_changes(self):
        first,review=[item for item in FIXTURE['records'] if item['recordId']=='r4-reading-attempt']
        for key in ['answers','score','correct','total','firstAttempt','contentHash']: self.assertEqual(first['request']['payload'][key],review['request']['payload'][key])
        self.assertNotEqual(first['expectedContentHash'],review['expectedContentHash']); self.assertEqual(review['request']['baseRevision'],first['request']['revisionId'])
for index,item in enumerate(FIXTURE['records']):
    def check(self,item=item):
        before=encoded(item['request']); validate_payload(item['request']['kind'],item['request']['payload'],item['recordId'])
        self.assertEqual(content_hash(item['request']['kind'],item['request']['payload']),item['expectedContentHash']); self.assertEqual(encoded(item['request']),before)
    setattr(R4ContractTest,f'test_shared_wire_{index+1:02d}',check)
for index,case in enumerate(FIXTURE['invalidCases']):
    def check(self,case=case):
        with self.assertRaisesRegex(LearningError,case['error']): validate_payload('attempt',invalid_payload(case),'r4-invalid')
    setattr(R4ContractTest,f'test_invalid_{index+1:02d}',check)
BASE={'planId':'r4-plan','contentId':'r4-independent','skill':'reading','answers':['a',None]}
FIELDS={'materialSource':'official','sourceRef':'Synthetic source','contentHash':'a'*64,'scope':'section','coverage':{'requestedWordIds':[],'coveredWordIds':[],'uncoveredWordIds':[],'matcherVersion':'r4-v1'},'reviewAnswers':['b',None]}
for field,value in FIELDS.items():
    def check(self,field=field,value=value): validate_payload('attempt',{**BASE,field:value},'r4-independent')
    setattr(R4ContractTest,f'test_independent_{field}',check)
if __name__=='__main__': unittest.main()
