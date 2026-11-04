"""R5 additive protocol, exact old bytes/hash, shared fixture and disposable SQLite."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
import uuid
try:
    from .app import Database
    from .learning import LearningError, LearningStore, content_hash, encoded, validate_payload
except ImportError:
    from app import Database
    from learning import LearningError, LearningStore, content_hash, encoded, validate_payload
FIXTURE = json.loads((Path(__file__).resolve().parents[1] / 'src/study365/fixtures/r5-records.json').read_text())
def record(record_id):
    return next(item for item in FIXTURE['records'] if item['recordId'] == record_id)
def changed(case):
    value=copy.deepcopy(record(case['recordId'])['request']['payload']); target=value
    for key in case['path'][:-1]: target=target[key]
    if case.get('remove'): del target[case['path'][-1]]
    else: target[case['path'][-1]]=case['value']
    return value
class R5ContractTest(unittest.TestCase):
    def test_reopen_receipts_keep_old_and_new_payloads_exactly(self):
        with tempfile.TemporaryDirectory(prefix='band-r5-contract-') as directory:
            database=Database(Path(directory)/'learning.sqlite3')
            with database.connect() as db:
                db.execute('INSERT INTO users VALUES(?,?,?,?)',('r5-test-user','r5-test-user','unused-test-hash',1))
            store=LearningStore(database); responses={}
            for item in FIXTURE['records']:
                status,response=store.put('r5-test-user',item['recordId'],item['request'])
                self.assertEqual(status,200); self.assertEqual(response['record']['payload'],item['request']['payload'])
                self.assertEqual(response['record']['contentHash'],item['expectedContentHash']); responses[item['request']['mutationId']]=(status,response)
            with database.connect() as db:
                rows=[tuple(row) for row in db.execute('SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq')]
                receipts=[tuple(row) for row in db.execute('SELECT * FROM learning_mutation_receipts ORDER BY mutation_id')]
                self.assertEqual(db.execute('SELECT count(*) FROM snapshots').fetchone()[0],0)
            reopened=LearningStore(Database(database.path))
            for item in FIXTURE['records']: self.assertEqual(reopened.put('r5-test-user',item['recordId'],item['request']),responses[item['request']['mutationId']])
            actual=reopened.list('r5-test-user')['items']; self.assertEqual(len(actual),len(FIXTURE['records']))
            for value,item in zip(actual,FIXTURE['records']): self.assertEqual(value['payload'],item['request']['payload'])
            with database.connect() as db:
                self.assertEqual(rows,[tuple(row) for row in db.execute('SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq')])
                self.assertEqual(receipts,[tuple(row) for row in db.execute('SELECT * FROM learning_mutation_receipts ORDER BY mutation_id')])
                self.assertEqual([row[0] for row in db.execute('SELECT version FROM learning_schema_migrations ORDER BY version')],[1,2])
    def test_optional_metadata_does_not_change_existing_text_hash_rules(self):
        for name in ['r5-source-essay','r5-source-speaking']:
            item=record(name); payload={**item['request']['payload'],'retestOf':item['request']['revisionId'],'correctionId':'r5-correction-writing' if name.endswith('essay') else 'r5-correction-speaking'}
            validate_payload(item['request']['kind'],payload,'r5-text-hash')
            self.assertEqual(content_hash(item['request']['kind'],payload),item['expectedContentHash'])
    def test_old_attempt_is_not_backfilled(self):
        item=record('r4-legacy-attempt'); original=encoded(item['request']['payload'])
        validate_payload('attempt',item['request']['payload'],item['recordId'])
        self.assertEqual(content_hash('attempt',item['request']['payload']),item['expectedContentHash'])
        self.assertEqual(encoded(item['request']['payload']),original)
        self.assertNotIn('retestOf',item['request']['payload']); self.assertNotIn('correctionId',item['request']['payload'])
    def test_exactly_fifty_distinct_items_keep_status_and_raw_payload(self):
        value=copy.deepcopy(record('r5-correction-reading')['request']['payload'])
        value['items']=[{'questionId':f'q{i+1}','errorCause':'vocab-unknown','action':'vocab-review','status':'open'} for i in range(50)]
        before=encoded(value);validate_payload('correction',value,'r5-fifty-items');self.assertEqual(encoded(value),before)
    def test_exact_utf16_note_limit(self):
        value={**record('r5-answer-key-correct')['request']['payload'],'note':'🙂'*1000}
        validate_payload('answerReview',value,'r5-note-boundary')
        with self.assertRaises(LearningError): validate_payload('answerReview',{**value,'note':value['note']+'x'},'r5-note-over')
    def test_new_references_are_owned_typed_dependencies_without_partial_writes(self):
        with tempfile.TemporaryDirectory(prefix='band-r5-reference-') as directory:
            database=Database(Path(directory)/'learning.sqlite3')
            with database.connect() as db:
                for name in ['r5-user-a','r5-user-b']:db.execute('INSERT INTO users VALUES(?,?,?,?)',(name,name,'unused-test-hash',1))
            store=LearningStore(database)
            for item in FIXTURE['records']:self.assertEqual(store.put('r5-user-a',item['recordId'],item['request'])[0],200)
            plan=record('r5-plan'); other_plan=copy.deepcopy(plan['request'])
            other_plan.update(revisionId=str(uuid.uuid4()),mutationId=str(uuid.uuid4()));other_plan['payload']['planId']='r5-other-plan'
            self.assertEqual(store.put('r5-user-a','r5-other-plan',other_plan)[0],200)
            self.assertEqual(store.put('r5-user-b',plan['recordId'],plan['request'])[0],200)
            def count():
                with database.connect() as db:return (db.execute('SELECT count(*) FROM learning_revisions').fetchone()[0],db.execute('SELECT count(*) FROM learning_mutation_receipts').fetchone()[0])
            before=count()
            def denied(name,kind,payload,status,detail=None,detail_value=None,user='r5-user-a'):
                body={'schemaVersion':2,'revisionId':str(uuid.uuid4()),'mutationId':str(uuid.uuid4()),'baseRevision':None,'kind':kind,'payload':payload}
                with self.assertRaises(LearningError,msg=name) as error:store.put(user,'r5-denied-'+uuid.uuid4().hex,body)
                self.assertEqual(error.exception.status,status,name)
                if detail:self.assertEqual(error.exception.body[detail],detail_value,name)
                self.assertEqual(count(),before,name)
            base=record('r5-correction-reading')['request']['payload'];missing=str(uuid.uuid4())
            denied('missing source','correction',{**base,'sourceRevisionId':missing},422,'missingRevisionId',missing)
            denied('wrong source record','correction',{**base,'sourceId':'r5-source-essay'},400)
            denied('wrong source kind','correction',{**base,'sourceRevisionId':record('r5-source-essay')['request']['revisionId']},400)
            denied('other plan source','correction',{**base,'planId':'r5-other-plan'},422,'missingRevisionId',base['sourceRevisionId'])
            denied('other account source','correction',base,422,'missingRevisionId',base['sourceRevisionId'],user='r5-user-b')
            retest=record('r5-reading-retest')['request']['payload']
            denied('feedback is not original work','attempt',{**retest,'retestOf':record('r5-source-feedback')['request']['revisionId']},400)
            denied('other skill source','attempt',{**retest,'retestOf':record('r5-source-listening')['request']['revisionId']},400)
            denied('missing correction','attempt',{**retest,'correctionId':'r5-missing-correction'},422,'missingRecordId','r5-missing-correction')
            denied('wrong correction kind','attempt',{**retest,'correctionId':'r5-source-essay'},422,'missingRecordId','r5-source-essay')
            denied('wrong correction skill','attempt',{**retest,'correctionId':'r5-correction-speaking'},400)
for index,item in enumerate(FIXTURE['records']):
    def check(self,item=item):
        before=encoded(item['request']);validate_payload(item['request']['kind'],item['request']['payload'],item['recordId'])
        self.assertEqual(content_hash(item['request']['kind'],item['request']['payload']),item['expectedContentHash']); self.assertEqual(encoded(item['request']),before)
    setattr(R5ContractTest,f'test_shared_wire_{index+1:02d}',check)
for index,case in enumerate(FIXTURE['invalidCases']):
    def check(self,case=case):
        with self.assertRaises(LearningError): validate_payload(record(case['recordId'])['request']['kind'],changed(case),'r5-invalid')
    setattr(R5ContractTest,f'test_invalid_{index+1:02d}',check)
for kind,name in [('attempt','r5-source-reading'),('essay','r5-source-essay'),('speaking','r5-source-speaking')]:
    def check(self,kind=kind,name=name):
        payload=record(name)['request']['payload']
        validate_payload(kind,{**payload,'retestOf':record(name)['request']['revisionId']},'r5-independent')
        validate_payload(kind,{**payload,'correctionId':'r5-correction'},'r5-independent')
    setattr(R5ContractTest,'test_independent_'+kind,check)
if __name__=='__main__': unittest.main()
