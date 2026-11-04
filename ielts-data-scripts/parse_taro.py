import re,json,glob,subprocess,os
os.makedirs('structured/cam-taro',exist_ok=True);rep=[]
for pdf in sorted(glob.glob('listening/taroflink-cam16-20/IELTS */Test */*.pdf')):
  b,t=map(int,re.findall(r'IELTS (\d+)/Test (\d)',pdf)[0])
  txt=subprocess.run(['pdftotext','-layout',pdf,'-'],capture_output=True,text=True).stdout
  k=txt.find('Answer Key');qs=txt[:k];key=txt[k:]
  ans={}
  for m in re.finditer(r'(?m)^\s{0,20}(\d{1,2})\s{2,}(\S.*?)(?:\s{3,}|$)',key):
    n=int(m.group(1))
    if 1<=n<=40 and n not in ans:ans[n]=m.group(2).strip()
  aud=sorted(glob.glob(os.path.dirname(pdf)+'/*.mp3'))
  o={'id':f'C{b}-T{t}-L','book':b,'test':t,'skill':'listening','materialSource':'cambridge','source':'https://github.com/TaroFlink/ielts-listening-practice','pdf':pdf,'answers':{str(k):v for k,v in sorted(ans.items())},'answerCount':len(ans),'questionsText':qs,'answerKeyText':key,'audio':aud}
  json.dump(o,open(f'structured/cam-taro/{o["id"]}.json','w'),ensure_ascii=False,indent=1);rep.append((b,t,len(ans),len(aud)))
print(rep)
