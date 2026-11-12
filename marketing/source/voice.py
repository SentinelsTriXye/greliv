import json, wave, subprocess, numpy as np
from piper import PiperVoice
try:
    from piper import SynthesisConfig
except Exception:
    from piper.config import SynthesisConfig
voice = PiperVoice.load('voice/fr_FR-tom-medium.onnx')
cfg = SynthesisConfig(length_scale=1.06, noise_scale=0.6, noise_w_scale=0.8)
# (scène, texte prononcé, sous-titre affiché)
SCENES = [
 [("Et si la livraison à Grenoble devenait plus simple, plus rapide, et plus locale ?", "Et si la livraison à Grenoble devenait plus simple,|plus rapide et plus locale ?"),
  ("Découvrez une nouvelle façon de commander, et de livrer, dans votre ville.", "Découvrez une nouvelle façon de commander|et de livrer dans votre ville.")],
 [("En quelques clics, découvrez vos restaurants préférés, choisissez votre repas, et commandez directement depuis votre téléphone.", "En quelques clics, découvrez vos restaurants préférés,|choisissez votre repas et commandez|directement depuis votre téléphone.")],
 [("Pour les commerçants, tout devient plus simple.", "Pour les commerçants, tout devient plus simple."),
  ("Les commandes arrivent instantanément, la préparation est organisée, et chaque livraison peut être suivie en temps réel.", "Les commandes arrivent instantanément,|la préparation est organisée|et chaque livraison peut être suivie en temps réel.")],
 [("Les livreurs reçoivent leurs missions directement sur leur téléphone.", "Les livreurs reçoivent leurs missions|directement sur leur téléphone."),
  ("Grâce à un GPS intelligent, ils sont guidés jusqu'au restaurant, puis jusqu'au client, avec un itinéraire optimisé.", "Grâce à un GPS intelligent, ils sont guidés|jusqu'au restaurant, puis jusqu'au client,|avec un itinéraire optimisé.")],
 [("Une expérience fluide, de la commande jusqu'à la livraison.", "Une expérience fluide,|de la commande jusqu'à la livraison."),
  ("Une solution pensée pour les Grenoblois, et leurs commerces de proximité.", "Une solution pensée pour les Grenoblois|et leurs commerces de proximité.")],
 [("Une ville.", "Une ville."), ("Des commerçants.", "Des commerçants."), ("Des livreurs.", "Des livreurs."), ("Une seule application.", "Une seule application."),
  ("La livraison locale entre dans une nouvelle ère.", "La livraison locale entre dans une nouvelle ère.")],
]
SR = 44100
def synth(text):
    chunks = list(voice.synthesize(text, syn_config=cfg))
    a = np.concatenate([c.audio_float_array for c in chunks]).astype(np.float32)
    idx = np.where(np.abs(a) > 0.01)[0]              # rogne les silences de début/fin
    return a[max(0, idx[0] - 800): idx[-1] + 3600]
LEAD = [1.0, 0.9, 0.8, 0.8, 0.9, 1.2]   # délai avant la voix dans chaque scène
TAIL = [1.3, 5.2, 2.6, 5.6, 2.4, 4.6]   # respiration visuelle après la voix
GAP  = [0.45, 0.4, 0.45, 0.45, 0.45, 0.42]
t = 0.0; cues = []; scenes = []; track = np.zeros(SR * 120, np.float32)
for si, sc in enumerate(SCENES):
    start = t; t += LEAD[si]
    for text, sub in sc:
        a = synth(text); n = len(a); dur = n / SR
        track[int(t * SR): int(t * SR) + n] += a
        parts = sub.split('|'); total = sum(len(p) for p in parts); u = t
        for p in parts:                               # découpe proportionnelle au nombre de caractères
            d = dur * len(p) / total
            cues.append({'a': round(u, 2), 'b': round(u + d + (0.25 if p is parts[-1] else 0), 2), 'text': p}); u += d
        t += dur + GAP[si]
    t += TAIL[si] - GAP[si]
    scenes.append({'a': round(start, 2), 'b': round(t, 2)})
total = t
track = track[: int(total * SR)]
track = track / np.abs(track).max() * 0.9
with wave.open('voice.wav', 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((track * 32767).astype(np.int16).tobytes())
json.dump({'total': round(total, 2), 'scenes': scenes, 'cues': cues}, open('timeline.json', 'w'), ensure_ascii=False, indent=1)
print('total', round(total, 2)); print(scenes)
