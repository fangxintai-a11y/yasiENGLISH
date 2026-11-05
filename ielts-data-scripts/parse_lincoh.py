import re,html,json,os
L='reading/lincoh-cam1-20/'
js=open(L+'data.js').read()
out=[];BOOKS={1,2,3,19,20}
for blk in re.split(r'\{\s*book: ',js)[1:]:
  book=int(blk.split(',')[0])
  if book not in BOOKS:continue
  for skill in ('reading','listening'):
    m=re.search(skill+r':\s*\[(.*?)\]',blk,re.S)
    if not m:continue
    for i,(tid,url) in enumerate(re.findall(r'id: "([^"]+)".*?url: "([^"]+)"',m.group(1))):
      slug=url.rstrip('/').rsplit('/',1)[1];p=L+'content/'+slug+'.html'
      if not os.path.exists(p):out.append({'book':book,'test':i+1,'skill':skill,'url':url,'status':'missing_cache'});continue
      raw=open(p,errors='ignore').read()
      a=raw.find('entry-content');raw2=raw[a:] if a>0 else raw
      imgs=sorted(set(re.findall(r'(?:data-src|src)="([^"]*/wp-content/uploads/[^"]+\.(?:png|jpe?g|webp|gif))"',raw2)))
      t=re.sub(r'<script.*?</script>|<style.*?</style>','',raw2,flags=re.S)
      t=re.sub(r'<br\s*/?>|</p>|</li>|</h\d>|</tr>','\n',t);t=html.unescape(re.sub(r'<[^>]+>',' ',t))
      t=re.sub(r'[ \t]+',' ',t);t=re.sub(r'\n\s*\n+','\n',t)
      k=t.find('Show Answers')
      body=t[:k].strip() if k>0 else t;ans_t=t[k+12:k+3000] if k>0 else ''
      ans={}
      for n_,v in re.findall(r'(?:^|\s)(\d{1,2})\s*[.)]\s*(.+?)(?=\s+\d{1,2}\s*[.)]\s|\n|$)',ans_t):
        n_=int(n_)
        if 1<=n_<=40 and n_ not in ans:ans[n_]=v.strip()
      if len(ans)<38:
        h=raw[raw.find('bg-showmore-hidden'):]
        h=h[:h.find('</ol>')]
        li=[html.unescape(re.sub(r'<[^>]+>','',x)).strip() for x in re.findall(r'<li>(.*?)</li>',h,re.S)]
        if len(li)>=len(ans):ans={i+1:v for i,v in enumerate(li[:40])}
      audio=None
      if skill=='listening':
        audio=[f'listening/maslow-cam1-20/ielts_listening/book_{book:02d}/test_{i+1}_part_{s}.mp3' for s in range(1,5)]
        audio=[x for x in audio if os.path.exists(x)]
      out.append({'id':f'C{book}-T{i+1}-{skill[0].upper()}','book':book,'test':i+1,'skill':skill,'source':url,'cache':p,'materialSource':'cambridge','answers':{str(k):v for k,v in sorted(ans.items())},'answerCount':len(ans),'text':body,'images':imgs,'audio':audio})
os.makedirs('structured/cam-lincoh',exist_ok=True)
for o in out:
  if 'id' in o:json.dump(o,open(f"structured/cam-lincoh/{o['id']}.json",'w'),ensure_ascii=False,indent=1)
print(json.dumps([{k:o.get(k) for k in('book','test','skill','answerCount','status')}|{'aud':len(o.get('audio') or []),'img':len(o.get('images') or [])} for o in out],ensure_ascii=False))
