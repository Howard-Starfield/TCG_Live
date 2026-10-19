"""Development-only original SVG/PNG/GIF artwork. Requires Pillow; never run by the bot."""
from pathlib import Path
from math import sin, cos, pi
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'apps/server/assets/discord'
COLORS = dict(signup='#38bdf8', checkin='#2dd4bf', setup='#a78bfa', running='#fbbf24',
              paused='#f87171', proposal='#fb923c', disputed='#fb923c', expired='#f87171',
              final='#4ade80', reminder='#fbbf24', notice='#38bdf8', error='#f87171')
STATIC = {'disputed', 'expired', 'error'}
INK, WHITE = '#172235', '#f8fafc'
SCALE = 4

class Art:
    def __init__(self):
        self.im = Image.new('RGBA', (96*SCALE, 96*SCALE))
        self.draw = ImageDraw.Draw(self.im)
        self.svg = []
    def ellipse(self, box, fill, stroke=None, width=1):
        self.draw.ellipse(tuple(v*SCALE for v in box), fill=fill, outline=stroke, width=width*SCALE)
        x, y, r, b = box
        self.svg.append(f'<ellipse cx="{(x+r)/2}" cy="{(y+b)/2}" rx="{(r-x)/2}" ry="{(b-y)/2}" fill="{fill or "none"}" stroke="{stroke or "none"}" stroke-width="{width}"/>')
    def line(self, points, fill=WHITE, width=3):
        self.draw.line([(x*SCALE,y*SCALE) for x,y in points], fill=fill, width=width*SCALE, joint='curve')
        self.svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in points)}" fill="none" stroke="{fill}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')
    def rect(self, box, fill):
        self.draw.rectangle(tuple(v*SCALE for v in box), fill=fill)
        x,y,r,b=box
        self.svg.append(f'<rect x="{x}" y="{y}" width="{r-x}" height="{b-y}" fill="{fill}"/>')
    def poly(self, points, fill):
        self.draw.polygon([(x*SCALE,y*SCALE) for x,y in points], fill=fill)
        self.svg.append(f'<polygon points="{" ".join(f"{x},{y}" for x,y in points)}" fill="{fill}"/>')
    def orb(self, y, color):
        self.ellipse((15,y,73,y+58), WHITE, INK, 3)
        self.draw.pieslice((15*SCALE,y*SCALE,73*SCALE,(y+58)*SCALE),180,360,fill=color)
        self.svg.append(f'<path d="M15,{y+29} A29,29 0 0 1 73,{y+29} Z" fill="{color}"/>')
        self.ellipse((15,y,73,y+58), None, INK, 3)
        self.line([(16,y+29),(72,y+29)],INK,4)
        self.ellipse((35,y+20,53,y+38), WHITE, INK, 3)
        self.ellipse((40,y+25,48,y+33), '#cbd5e1')
        self.ellipse((24,y+10,32,y+14), '#ffffff')
    def image(self):
        return self.im.resize((96,96),Image.Resampling.LANCZOS)
    def source(self):
        return '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">'+''.join(self.svg)+'</svg>\n'

def frame(state, step):
    a=Art(); color=COLORS[state]; t=step*2*pi/12
    bob=round(sin(t)*2) if state not in STATIC else 0
    a.ellipse((16,78,72,85),'#334155')
    a.orb(15+bob,color)
    # A distinct badge carries meaning even with animation disabled.
    a.ellipse((56,54,91,89),WHITE)
    a.ellipse((59,57,88,86),INK)
    if state in {'error','disputed','expired'}:
        a.poly([(73,61),(84,80),(62,80)],color)
        a.line([(73,67),(73,73)],INK,3); a.ellipse((72,76,74,78),INK)
    elif state in {'final','checkin'}:
        a.line([(65,71),(71,77),(82,65)],color,4)
    elif state=='paused':
        a.rect((66,65,71,78),color); a.rect((76,65,81,78),color)
    elif state=='signup':
        a.line([(65,72),(81,72)],color,4); a.line([(73,64),(73,80)],color,4)
    elif state=='running':
        a.ellipse((64,63,82,81),INK,color,2)
        a.line([(73,72),(73+round(cos(t)*6),72+round(sin(t)*6))],color,2)
        a.line([(73,72),(73,67)],WHITE,2)
    elif state=='reminder':
        a.poly([(65,77),(67,66),(70,63),(76,63),(79,66),(81,77)],color)
        a.ellipse((71,79,75,82),color)
        a.line([(61,65),(61,70)],color,2); a.line([(85,65),(85,70)],color,2)
    elif state=='proposal':
        a.line([(67,66),(70,63),(77,63),(80,66),(78,70),(73,73),(73,75)],color,3)
        a.ellipse((72,78,74,80),color)
    elif state=='setup':
        a.ellipse((65,65,71,71),color); a.ellipse((76,65,82,71),color)
        a.line([(65,77),(71,77)],color,3); a.line([(76,77),(82,77)],color,3)
    else:
        a.ellipse((71,63,75,67),color); a.line([(73,70),(73,80)],color,4)
    if state not in STATIC:
        for i,(x,y) in enumerate([(10,24),(82,16),(9,62)]):
            v=2 if (step+i*3)%12<6 else 1
            a.line([(x-v,y),(x+v,y)],color,2); a.line([(x,y-v),(x,y+v)],color,2)
    if state=='final':
        for i,c in enumerate(['#fbbf24','#38bdf8','#fb7185']):
            x=28+i*14; y=3+(step+i*4)%12
            a.rect((x,y,x+3,y+5),c)
    return a

def palette(im):
    p=im.convert('RGB').quantize(colors=255)
    p.paste(255,mask=im.getchannel('A').point(lambda v:255 if v<128 else 0))
    p.info['transparency']=255
    return p

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    for state in COLORS:
        first=frame(state,0)
        (OUT/f'tcg-{state}-v1.svg').write_text(first.source(),encoding='utf8')
        if state in STATIC:
            first.image().save(OUT/f'tcg-{state}-v1.png')
        else:
            frames=[palette(frame(state,i).image()) for i in range(12)]
            frames[0].save(OUT/f'tcg-{state}-v1.gif',save_all=True,append_images=frames[1:],
                           duration=120,loop=0,disposal=2,transparency=255,optimize=False)
    preview=Image.new('RGB',(720,456),'#1e1f22'); d=ImageDraw.Draw(preview)
    try: font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',16)
    except OSError: font=ImageFont.load_default()
    for i,state in enumerate(COLORS):
        x=12+(i%4)*177; y=12+(i//4)*145
        d.rounded_rectangle((x,y,x+165,y+133),radius=10,fill='#2b2d31')
        extension='png' if state in STATIC else 'gif'
        with Image.open(OUT/f'tcg-{state}-v1.{extension}') as encoded:
            if extension=='gif': encoded.seek(4 if i%2 else 0)
            asset=encoded.convert('RGBA')
        preview.paste(asset,(x+34,y+8),asset)
        d.text((x+12,y+108),state.upper(),font=font,fill=COLORS[state])
    preview.save(OUT/'visual-contact-sheet.png')
    print(f'Generated {len(COLORS)} original status visuals, SVG sources and contact sheet.')

if __name__=='__main__': main()
