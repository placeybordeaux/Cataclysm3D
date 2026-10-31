# Contact sheet of zombie sprites from the project's UltiCa atlas.
import json,os,sys
from PIL import Image, ImageDraw
A=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','public','atlas','')
a=json.load(open(A+'atlas.json'))
pages=[Image.open(A+p['file']).convert('RGBA') for p in a['pages']]
ids=sys.argv[2].split(',')
S=6
cells=[]
for i in ids:
  t=a['tiles'].get(i)
  if not t: print('missing',i); continue
  fg=t.get('fg')
  sp=fg[0]['sprites'][0] if fg else None
  if isinstance(sp,list): sp=sp[0]
  f=a['frames'][sp]
  im=pages[f['page']].crop((f['x'],f['y'],f['x']+f['w'],f['y']+f['h']))
  cells.append((i,im.resize((f['w']*S,f['h']*S),Image.NEAREST)))
W=max(c[1].width for c in cells)+10; H=max(c[1].height for c in cells)+24
cols=8; rows=(len(cells)+cols-1)//cols
out=Image.new('RGBA',(W*cols,H*rows),(70,70,70,255)); d=ImageDraw.Draw(out)
for k,(i,im) in enumerate(cells):
  x=(k%cols)*W; y=(k//cols)*H
  out.alpha_composite(im,(x+5,y+20)); d.text((x+4,y+4),i.replace('mon_',''),fill=(255,255,255,255))
out.save(sys.argv[1])
