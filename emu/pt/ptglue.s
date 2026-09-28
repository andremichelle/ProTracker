; Glue around the original ProTracker 2.3A CIA playroutine (PT-CIAPlay.s) so
; the host emulator can drive it without an operating system.
;
; The host reads the entry table at the start of the code hunk and installs
; Lev6 as the level 6 (CIA-B) interrupt handler. Lev6 does what exec's CIA
; resource does: read the ICR and call the vector registered via
; AddICRVector for timer A with A1 = is_Data.

	section	code,code

EntryTab:
	bra.w	SetCIAInt		; +0
	bra.w	mt_init			; +4
	bra.w	mt_end			; +8
	bra.w	Lev6			; +12
	dc.l	mt_Enable		; +16
	dc.l	mt_speed		; +20
	dc.l	mt_SongPos		; +24
	dc.l	mt_PatternPos		; +28
	dc.l	RealTempo		; +32
	dc.l	Vec			; +36  is_Code, is_Data for CIA-B timer A
	dc.b	"PTCI"			; +40  magic for the host

Lev6:
	movem.l	d0-d1/a0-a1/a5-a6,-(sp)
	move.b	$bfdd00,d0		; read and clear CIA-B ICR
	btst	#0,d0
	beq.s	.done
	move.l	Vec(pc),d1
	beq.s	.done
	move.l	d1,a5
	move.l	Vec+4(pc),a1
	jsr	(a5)
.done:	move.w	#$2000,$dff09c
	movem.l	(sp)+,d0-d1/a0-a1/a5-a6
	rte

Vec:	dc.l	0,0

mt_data		= $80000		; the host copies the module here
CloseLibrary	= -414

	include	"PT-CIAPlay.s"
