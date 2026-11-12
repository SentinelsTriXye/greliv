# Bande-son électronique originale, synthétisée (aucun échantillon tiers).
import numpy as np, wave
SR = 44100; BAR = 13.04 / 6; BEAT = BAR / 4; TOTAL = 85.6
N = int(TOTAL * SR); t = np.arange(N) / SR
rng = np.random.default_rng(7)
def lowpass(x, fc, order=2):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / (1 + (f / fc) ** (2 * order)), len(x))
def highpass(x, fc):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X * (f / fc) ** 2 / (1 + (f / fc) ** 2), len(x))
def place(buf, sig, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf) or i < 0: return
    n = min(len(sig), len(buf) - i); buf[i:i + n] += sig[:n] * gain
def env(n, a, d):  # attaque/décroissance exponentielle
    x = np.arange(n) / SR
    return np.minimum(1, x / a) * np.exp(-x / d)
midi = lambda m: 440 * 2 ** ((m - 69) / 12)
CHORDS = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 60], [55, 59, 62, 66 - 1]]  # Am7, Fmaj7, C, G
ROOTS = [45, 41, 36, 43]
def bars(a, b): return range(a, b)
NB = int(TOTAL / BAR) + 1
# sections (en mesures)
INTRO, BUILD, FULL, BREAK, FINALE, END = 0, 6, 12, 27, 32, 38

# Nappe : dents de scie désaccordées filtrées
pad = np.zeros(N)
for b in range(NB):
    ch = CHORDS[(b // 2) % 4]; n = int(BAR * SR) + 2000; x = np.arange(n) / SR; s = np.zeros(n)
    for m in ch:
        for det in (-0.006, 0, 0.007):
            f = midi(m) * (1 + det); s += 2 * ((x * f) % 1) - 1
    e = np.minimum(1, x / 0.25) * np.minimum(1, (n / SR - x) / 0.3).clip(0, 1)
    place(pad, s * e / 12, b * BAR)
pad = lowpass(pad, 1400)

# Arpège : notes en doubles croches avec écho
arp = np.zeros(N); n16 = BEAT / 4
pl = int(0.32 * SR); px = np.arange(pl) / SR
for b in range(NB):
    ch = CHORDS[(b // 2) % 4]; pat = [0, 1, 2, 3, 2, 1, 2, 3, 0, 2, 1, 3, 2, 1, 3, 2]
    for k in range(16):
        f = midi(ch[pat[k]] + 12); s = np.sin(2 * np.pi * f * px) + 0.4 * np.sin(4 * np.pi * f * px)
        place(arp, s * env(pl, 0.004, 0.09), b * BAR + k * n16, 0.5 if k % 4 else 0.8)
d = int(BEAT * 0.75 * SR); echo = arp.copy()
for i, g in ((1, 0.45), (2, 0.22), (3, 0.1)): echo[i * d:] += arp[:-i * d] * g
arp = echo

# Basse, grosse caisse, charleston, clap
bass = np.zeros(N); kick = np.zeros(N); hat = np.zeros(N); clap = np.zeros(N); duck = np.ones(N)
kl = int(0.32 * SR); kx = np.arange(kl) / SR
ksig = np.sin(2 * np.pi * (45 * kx + (150 - 45) * 0.035 * (1 - np.exp(-kx / 0.035)))) * np.exp(-kx / 0.11)
hl = int(0.06 * SR); hsig = highpass(rng.standard_normal(hl * 4), 7000)[:hl] * env(hl, 0.001, 0.014)
cl = int(0.22 * SR); csig = highpass(lowpass(rng.standard_normal(cl), 3500), 900) * env(cl, 0.002, 0.07)
bl = int(n16 * 2 * SR); bx = np.arange(bl) / SR
dl = int(BEAT * SR); dshape = 1 - 0.65 * np.exp(-np.arange(dl) / SR / 0.11)
for b in range(BUILD, END):
    light = BREAK <= b < FINALE
    for q in range(4):
        tq = b * BAR + q * BEAT
        place(kick, ksig, tq, 0.55 if light else 1.0)
        i = int(tq * SR); duck[i:i + dl] = np.minimum(duck[i:i + dl], dshape[: max(0, min(dl, N - i))]) if i < N else duck[i:i + dl]
        if b >= FULL and not light and q in (1, 3): place(clap, csig, tq)
        for h in range(2): place(hat, hsig, tq + BEAT / 2 + h * 0, 1.0) if h == 0 else place(hat, hsig, tq + BEAT * 0.75, 0.35 if b >= FULL else 0)
    if not light:
        f = midi(ROOTS[(b // 2) % 4])
        for k in range(8):
            s = np.sin(2 * np.pi * f * bx) + 0.5 * (2 * ((bx * f) % 1) - 1)
            place(bass, s * env(bl, 0.005, 0.16), b * BAR + k * n16 * 2, 1.0 if k % 2 else 0.75)
bass = lowpass(bass, 420)

# Montées de bruit avant les changements de section
riser = np.zeros(N)
for b in (BUILD, FULL, FINALE):
    n = int(BAR * 2 * SR); x = np.linspace(0, 1, n); s = rng.standard_normal(n) * x ** 2.2
    place(riser, highpass(s, 1500 ), b * BAR - BAR * 2, 0.5)
# Impact final + résonance
hit = np.zeros(N); n = int(3.2 * SR); x = np.arange(n) / SR
s = sum(np.sin(2 * np.pi * midi(m) * x) for m in (45, 57, 60, 64, 69)) * np.exp(-x / 1.1) / 5 + np.sin(2 * np.pi * 50 * x) * np.exp(-x / 0.3)
place(hit, s, END * BAR)

def gain(points):  # automation linéaire (mesure, niveau)
    return np.interp(t, [p[0] * BAR for p in points], [p[1] for p in points])
mix = (pad * gain([(0, 0), (1, .55), (BUILD, .6), (FULL, .5), (BREAK, .7), (FINALE, .55), (END, .5), (END + .2, 0)]) * (0.45 + 0.55 * duck)
     + arp * gain([(0, 0), (2, .16), (BUILD, .3), (FULL, .34), (BREAK, .26), (FINALE, .36), (END, .3), (END + .1, 0)]) * (0.6 + 0.4 * duck)
     + bass * 0.5 * duck + kick * 0.85 + hat * 0.16 + clap * 0.3 + riser * 0.35 + hit * 0.9)
# stéréo légère : l'arpège et le charleston sont décalés entre gauche et droite
sh = int(0.011 * SR); side = (arp * 0.2 + hat * 0.1 + pad * 0.15)
L = mix + np.roll(side, sh) * 0.5; R = mix + np.roll(side, -sh) * 0.5
st = np.stack([L, R], 1); st = np.tanh(st * 1.3) / np.tanh(1.3)
fade = np.minimum(1, (TOTAL - t) / 1.6).clip(0, 1) * np.minimum(1, t / 0.4)
st = st / np.abs(st).max() * 0.92 * fade[:, None]
with wave.open('music.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype(np.int16).tobytes())
print('ok', TOTAL)
