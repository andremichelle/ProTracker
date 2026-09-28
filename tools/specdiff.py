#!/usr/bin/env python3
"""Phase-insensitive comparison of two renders: fine envelopes, per-second
spectral correlation, local lag, and a spectrogram picture.
Needs numpy and matplotlib.

Usage: specdiff.py A.wav B.wav seconds out.png
"""
import sys, wave, numpy as np
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
def load(p, secs):
    w=wave.open(p); sr=w.getframerate(); n=min(w.getnframes(), int(secs*sr)); d=np.frombuffer(w.readframes(n), dtype='<i2').reshape(-1,2).astype(np.float32)/32768; w.close(); return sr, d
A_path, B_path, secs = sys.argv[1], sys.argv[2], float(sys.argv[3])
sr, A = load(A_path, secs); _, B = load(B_path, secs)
n=min(len(A),len(B)); A=A[:n]; B=B[:n]
# global alignment via 10 ms envelope
def env(x, hop): m=len(x)//hop; return np.sqrt((x[:m*hop].reshape(m,hop)**2).mean(1))
hop=sr//100; ea=env(A.mean(1),hop); eb=env(B.mean(1),hop)
lags=range(-100,101); c=[np.corrcoef(ea[max(0,-l):len(eb)+min(0,-l)], eb[max(0,l):len(ea)+min(0,l)])[0,1] for l in lags]
L=lags[int(np.argmax(c))]*hop
if L>0: B=B[L:]; A=A[:len(B)]
elif L<0: A=A[-L:]; B=B[:len(A)]
print(f'coarse lag {L/sr*1000:+.1f} ms')
# fine lag on first 5 s
w=5*sr; best=max(((np.corrcoef(A[200:w,0], B[200+l:w+l,0])[0,1], l) for l in range(-96,97,1)), key=lambda t:t[0]); l=best[1]
if l>0: B=B[l:]; A=A[:len(B)]
elif l<0: A=A[-l:]; B=B[:len(A)]
print(f'fine lag {l/sr*1e6:+.0f} us, waveform corr first 5 s {best[0]:+.3f}')
n=min(len(A),len(B)); A=A[:n]; B=B[:n]
# 1 ms envelope correlation per channel
for ch,name in ((0,'L'),(1,'R')):
    ea=env(A[:,ch], sr//1000); eb=env(B[:,ch], sr//1000)
    print(f'1 ms envelope corr {name}: {np.corrcoef(ea,eb)[0,1]:+.3f}')
# per-second: spectral magnitude correlation and best local lag (+-2 ms)
print('per second: spectral corr | local lag us | waveform corr at local lag')
for s in range(n//sr):
    a=A[s*sr:(s+1)*sr,0]; b=B[s*sr:(s+1)*sr,0]
    fa=np.abs(np.fft.rfft(a*np.hanning(len(a))))[:len(a)//4]; fb=np.abs(np.fft.rfft(b*np.hanning(len(b))))[:len(b)//4]
    sc=np.corrcoef(np.log1p(fa),np.log1p(fb))[0,1]
    seg=a[2000:-2000]; best=(-2,0)
    for l in range(-96,97,2):
        cc=np.corrcoef(seg, b[2000+l:len(b)-2000+l])[0,1]
        if cc>best[0]: best=(cc,l)
    print(f'  {s:2d}s  {sc:+.3f}  {best[1]/sr*1e6:+6.0f}  {best[0]:+.3f}')
# spectrograms of first 12 s, left channel
fig,ax=plt.subplots(3,1,figsize=(14,10),sharex=True)
T=12*sr
for i,(x,t) in enumerate(((A[:T,0],'A: '+A_path),(B[:T,0],'B: '+B_path))):
    ax[i].specgram(x, NFFT=1024, Fs=sr, noverlap=768, cmap='magma', vmin=-120, vmax=-20); ax[i].set_title(t); ax[i].set_ylim(0,20000)
ax[2].plot(np.arange(T)/sr, A[:T,0], lw=0.3, label='A'); ax[2].plot(np.arange(T)/sr, B[:T,0]-1.0, lw=0.3, label='B (offset)'); ax[2].set_xlim(0,12); ax[2].legend(); ax[2].set_title('waveforms')
plt.tight_layout(); plt.savefig(sys.argv[4], dpi=80)
