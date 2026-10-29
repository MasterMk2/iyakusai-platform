"""Small Windows GUI for issuing and reading committee login cards. No production API writes."""
from __future__ import annotations
import json
from pathlib import Path
import queue
import sys
import threading
import time

BASE = Path(__file__).resolve().parent
SOURCE = BASE.parent / 'issuer'
sys.path[:0] = [str(SOURCE / 'desktop'), str(SOURCE / 'card'), str(SOURCE / 'card' / '.deps')]
import single_card_trial as trial
import reader_bridge
from card_writer import ORIGIN, validate_login_url, verify_card, write_blank_card


def self_check():
    import ctypes
    import nfc
    import usb1
    synthetic = ORIGIN + '/card#' + 'a' * 43
    encoded = validate_login_url(synthetic)
    assert trial.decode_url(encoded) == synthetic
    assert reader_bridge.item_code(synthetic, {ORIGIN}) == 'LOGIN-CARD'
    binary_root = Path(getattr(sys, '_MEIPASS', SOURCE / 'card' / '.deps'))
    ctypes.WinDLL(str(binary_root / 'usb1' / 'libusb-1.0.dll'))
    print(json.dumps({'status': 'passed', 'ndef_bytes': len(encoded), 'login_cards': True, 'libusb_loaded': True, 'usb_accessed': False, 'card_written': False}))


def main():
    if '--self-check' in sys.argv:
        self_check()
        return
    import tkinter as tk
    from tkinter import ttk
    from tkinter import messagebox
    root = tk.Tk()
    root.title('医薬祭 委員カード')
    root.geometry('680x580')
    root.minsize(460, 500)
    frame = ttk.Frame(root, padding=22)
    frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='委員カードの書込み・読取り', font=('Yu Gothic UI', 18, 'bold')).pack(anchor='w')
    ttk.Label(frame, text='物品カードとは別の、空のFeliCa Lite-Sカードを使います。\n既存の発行履歴・物品台帳には触れません。', wraplength=600).pack(anchor='w', pady=10)
    status = tk.StringVar(value='ログイン用の読取りか、カードの書込みを選んでください。')
    ttk.Label(frame, textvariable=status, wraplength=600, font=('Yu Gothic UI', 12)).pack(fill='x', pady=12)
    events = queue.Queue()
    bridge = None
    worker = None
    cancel = threading.Event()
    url = tk.StringVar()
    buttons = []

    def emit(event):
        # The bridge redacts login URLs; only operator text reaches the GUI.
        events.put(('status', event.get('text', '')))

    def start_reader():
        nonlocal bridge
        if worker is not None and worker.is_alive():
            return
        try:
            bridge = reader_bridge.ReaderBridge(emit, [ORIGIN], [ORIGIN])
            bridge.start()
            status.set('読取ソフトを起動しました。ブラウザで「PCの読取機に接続」を押してください。')
        except Exception:
            status.set('読取機を起動できません。別の物品読取ソフトが起動中なら停止してください。既存ソフトの強制終了はしません。')

    def stop_reader():
        nonlocal bridge
        if bridge:
            bridge.stop()
            bridge = None
        status.set('読取りを止めました。')

    row = ttk.Frame(frame)
    row.pack(fill='x')
    ttk.Button(row, text='ログイン用の読取りを開始', command=start_reader).pack(side='left', padx=(0, 10))
    ttk.Button(row, text='読取りを止める', command=stop_reader).pack(side='left')
    ttk.Separator(frame).pack(fill='x', pady=22)
    ttk.Label(frame, text='カード発行担当用', font=('Yu Gothic UI', 13, 'bold')).pack(anchor='w')
    ttk.Label(frame, text='基盤システムの「設定 → 委員カード」でコピーした書込み情報', wraplength=600).pack(anchor='w', pady=(8, 4))
    entry = ttk.Entry(frame, textvariable=url, show='●')
    entry.pack(fill='x')

    def paste():
        try: url.set(root.clipboard_get().strip())
        except tk.TclError: status.set('コピーした書込み情報がありません。')
    ttk.Button(frame, text='コピーした書込み情報を貼り付け', command=paste).pack(anchor='w', pady=8)

    def start_write(verify=False):
        nonlocal worker
        if worker is not None and worker.is_alive(): return
        secret = url.get().strip()
        try: validate_login_url(secret)
        except Exception:
            status.set('書込み情報が正しくありません。設定画面からコピーしてください。')
            return
        if not verify and not messagebox.askyesno('空の委員カードへ書込み', 'カードにログイン用の情報を書き込みます。物品カードなど、データがあるカードは上書きしません。空の委員カードを用意しましたか？'):
            return
        stop_reader()
        cancel.clear()
        for button in buttons: button.configure(state='disabled')
        status.set('空の委員カードをタッチしてください。' if not verify else '確認する委員カードをタッチしてください。')

        def run():
            try:
                import nfc
                with nfc.ContactlessFrontend(trial.READER) as clf:
                    trial.disable_write_retries(clf)
                    tag = trial.acquire_one(clf, 45)
                    if tag is None or cancel.is_set(): raise trial.TrialError('カードを確認できません。')
                    def reacquire(old, idm, text):
                        events.put(('status', text))
                        deadline = time.monotonic() + 45
                        while old.is_present:
                            if cancel.is_set() or time.monotonic() > deadline: raise trial.TrialError('カードを離してから、もう一度確認してください。')
                            time.sleep(.1)
                        return trial.acquire_one(clf, 45, expected_id=idm, ndef_only=True)
                    result = verify_card(tag, secret) if verify else write_blank_card(tag, secret, reacquire)
                    events.put(('success', '読取確認が成功しました（カード末尾 ' + result['idm_tail'] + '）。設定画面へ戻り、このカードを有効化してください。'))
            except Exception:
                # Exceptions from NFC/URL libraries may contain raw data. Do not display or log them.
                events.put(('failure', '書込み・読取確認を完了できませんでした。有効化しないでください。読取機/ドライバー/カードを確認し、書込み済みなら「書込み済みカードを確認」を使ってください。'))
            finally: events.put(('done', ''))
        worker = threading.Thread(target=run, daemon=True)
        worker.start()

    for text, verify in [('空のカードに書き込む', False), ('書込み済みカードを確認', True)]:
        button = ttk.Button(frame, text=text, command=lambda v=verify: start_write(v))
        button.pack(anchor='w', pady=5)
        buttons.append(button)
    ttk.Label(frame, text='書込み情報はファイルやログに保存しません。紛失したカードは設定画面で停止してください。\nPCごとにRC-S370用WinUSBドライバーが必要です。', wraplength=600).pack(anchor='w', pady=14)

    def poll():
        try:
            while True:
                kind, text = events.get_nowait()
                if kind == 'done':
                    for button in buttons: button.configure(state='normal')
                else:
                    status.set(text)
                    if kind == 'success':
                        # Clear the clipboard only when it still contains this card's credential.
                        try:
                            if root.clipboard_get().strip() == url.get().strip(): root.clipboard_clear()
                        except tk.TclError: pass
                        url.set('')
        except queue.Empty: pass
        root.after(100, poll)
    def close():
        if worker is not None and worker.is_alive():
            status.set('書込み・読取確認の処理中です。完了または中止の表示が出てから閉じてください。')
            return
        cancel.set()
        if bridge: bridge.stop()
        url.set('')
        root.destroy()
    root.protocol('WM_DELETE_WINDOW', close)
    if '--gui-selfcheck' in sys.argv:
        root.withdraw()
        root.update_idletasks()
        assert len(buttons) == 2 and entry.winfo_exists()
        print(json.dumps({'status': 'passed', 'gui_constructed': True, 'writer_actions': len(buttons), 'usb_accessed': False, 'card_written': False}))
        root.destroy()
        return
    root.after(100, poll)
    root.mainloop()


if __name__ == '__main__': main()
