"""Native Windows issuing desk: one plan, one label PDF, the same card URLs.

Also the reading desk for loans and returns: the "貸出・返却の読取り" tab, or 物品読取.exe (the same program
under another name, or --reader) for a small window with only that. It reads cards on the RC-S370 and hands
them to the rental screen in the browser (reader_bridge); it never writes a card.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import queue
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk
from tkinter import font as tkfont
from datetime import datetime
from urllib.parse import urlsplit
import webbrowser

HERE = Path(__file__).resolve().parent
if not getattr(sys, 'frozen', False):
    sys.path[:0] = [str(HERE.parent / 'card'), str(HERE.parent / 'labels')]
import workflow
try:
    # 物品マスターの Excel の読み取りは、その表の形と業者・団体の名前に合わせた委員会ごとの部品で、公開版には無い。
    # 無いときは Excel の取り込みだけを使えなくし、手入力・貼り付けで台帳を作る。
    import excel_import
except ImportError:
    excel_import = None
import writer_worker
import reader_bridge
import reconcile
import single_card_trial as trial
import manifest_batch as batch
import card_state
import server_history

DEFAULT_ORIGIN = workflow.DEFAULT_ORIGIN
KNOWN_ORIGINS = [workflow.UNIFIED_ORIGIN, workflow.LEGACY_ORIGIN]
DEFAULT_EXCEL = Path.home() / 'Downloads' / 'レンタル物品まとめ.xlsx'
ALL_EXCEL_SHEETS = '全団体（対応シートをまとめて取り込む）'
# The same executable copied under this name opens only the reading window.
READER_EXE = '物品読取'


def excel_plan_text(rows, include_master_code=False):
    """Retain category codes on labels without changing physical item IDs."""
    lines = []
    for row in workflow.prepare_set_rows(rows):
        code = row.get('source', {}).get('master_item_code', '')
        name = f"[{code}] {row['name']}" if include_master_code and code else row['name']
        values = [row['borrower_name'], name, str(row['quantity'])]
        if 'item_scope' in row or 'item_owner' in row:
            values.append(row.get('item_scope') or '区分未確認')
        if row.get('item_owner'):
            values.append(row['item_owner'])
        lines.append('\t'.join(values))
    return '\n'.join(lines) + '\n'


def configuration():
    home = Path(sys.executable).parent if getattr(sys, 'frozen', False) else HERE
    config = home / 'app-config.json'
    if not config.is_file():
        return {}
    try:
        value = json.loads(config.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {'error':'設定ファイルの形式が違います'}
    except (OSError, ValueError):
        return {'error':'設定ファイルを読み取れません'}


def reader_origins(config, extra=()):
    """Origins of the rental screen and of card URLs the reading desk accepts (the app's, plus test ones)."""
    values = [*config.get('known_origins', []), config.get('origin', ''), *KNOWN_ORIGINS, *extra]
    return [o for o in dict.fromkeys(v.strip().rstrip('/') for v in values if isinstance(v, str)) if o]


def apply_styles(root):
    s = ttk.Style(root)
    s.theme_use('clam')
    s.configure('.', font=('Meiryo UI', 10), background='#f3f6f8', foreground='#243746')
    s.configure('TButton', padding=(12, 7))
    s.configure('Primary.TButton', background='#155a86', foreground='white', font=('Meiryo UI', 11, 'bold'), padding=(20, 10))
    s.map('Primary.TButton', background=[('disabled', '#d5dfe5'), ('active', '#10476b')], foreground=[('disabled', '#667986')])
    s.configure('TNotebook', borderwidth=0, tabmargins=(0, 4, 0, 0))
    s.configure('TNotebook.Tab', padding=(20, 10))
    s.map('TNotebook.Tab', background=[('selected', 'white')], foreground=[('selected', '#155a86')])
    s.configure('Treeview', background='white', fieldbackground='white', rowheight=30)
    s.configure('Treeview.Heading', font=('Meiryo UI', 10, 'bold'), padding=5)
    s.configure('Title.TLabel', font=('Meiryo UI', 18, 'bold'))
    s.configure('Section.TLabel', font=('Meiryo UI', 11, 'bold'))
    s.configure('Hint.TLabel', foreground='#526473', font=('Meiryo UI', 9))
    s.configure('Big.TLabel', font=('Meiryo UI', 27, 'bold'), foreground='#155a86')
    s.configure('Ok.TLabel', foreground='#16664c', font=('Meiryo UI', 10, 'bold'))
    s.configure('Warn.TLabel', foreground='#b13532', font=('Meiryo UI', 10, 'bold'))
    s.configure('Work.TFrame', background='white')
    s.configure('Work.TLabel', background='white')
    s.configure('WorkHint.TLabel', background='white', foreground='#526473', font=('Meiryo UI', 9))
    s.configure('Number.TLabel', background='white', foreground='#155a86', font=('Meiryo UI', 34, 'bold'))
    s.configure('CompactNumber.TLabel', background='white', foreground='#155a86', font=('Meiryo UI', 25, 'bold'))
    s.configure('Item.TLabel', background='white', font=('Meiryo UI', 16, 'bold'))
    s.configure('CompactItem.TLabel', background='white', font=('Meiryo UI', 12, 'bold'))
    for name, color in [('Next', '#155a86'), ('Success', '#16664c'), ('Error', '#b13532'), ('Wait', '#99520f')]:
        s.configure(name + '.TLabel', background='white', foreground=color, font=('Meiryo UI', 16, 'bold'))
    s.configure('TProgressbar', background='#16664c', troughcolor='#e7edf1', borderwidth=0)


class ReaderPanel(ttk.Frame):
    """Loans and returns at a Windows desk: cards on the RC-S370 open in the rental screen of the browser.

    Reads only. The borrower, photos, condition and registration are done on the rental screen.
    can_start() returns why reading may not start now (e.g. card writing uses the reader), or ''.
    """

    def __init__(self, parent, origin, page_origins, card_origins, can_start=lambda: '', on_change=lambda: None):
        super().__init__(parent, padding=16)
        self.origin, self.can_start, self.on_change = origin, can_start, on_change
        self.events = queue.Queue()
        self.bridge = reader_bridge.ReaderBridge(self.events.put, page_origins, card_origins)
        self.reader_text = tk.StringVar(value='「読取りを開始」を押すまで、読取機は使いません。')
        self.browser_text = tk.StringVar(value='')
        self.last_code = tk.StringVar(value='—')
        self.last_note = tk.StringVar(value='カードを読むと、ここに No. が出ます。')
        ttk.Label(self, text='物品の貸出・返却を、このPCにつないだ RC-S370 で行います。カードを置くと、ブラウザの物品画面にその物品が開きます。貸出先・写真・返却の状態・登録は物品画面で行います。カードには書き込みません。', style='Hint.TLabel', wraplength=900).pack(anchor='w')
        steps = ('1. 「読取りを開始」を押す（物品画面がブラウザで開きます）\n'
                 '2. ブラウザで医薬祭アカウントにログインする。初回は「ローカル ネットワーク（このPCの機器）へのアクセス」を許可する\n'
                 '3. 物品画面のボタンが「PCの読取機を止める」になり、下の「ブラウザ」がつながっていれば準備完了\n'
                 '4. カードを1枚ずつ置き、物品画面で登録したらカードを離して次へ')
        ttk.Label(self, text=steps, justify='left').pack(anchor='w', pady=(8, 10))
        buttons = ttk.Frame(self)
        buttons.pack(fill='x')
        self.start_button = ttk.Button(buttons, text='読取りを開始', style='Primary.TButton', command=lambda: self.start(open_browser=True))
        self.start_button.pack(side='left')
        self.stop_button = ttk.Button(buttons, text='停止', command=self.stop, state='disabled')
        self.stop_button.pack(side='left', padx=8)
        ttk.Button(buttons, text='物品画面を開く', command=self.open_screen).pack(side='left')
        status = ttk.Frame(self)
        status.pack(fill='x', pady=(12, 0))
        ttk.Label(status, text='読取機').grid(row=0, column=0, sticky='nw', padx=(0, 10))
        self.reader_label = ttk.Label(status, textvariable=self.reader_text, wraplength=820)
        self.reader_label.grid(row=0, column=1, sticky='w')
        ttk.Label(status, text='ブラウザ').grid(row=1, column=0, sticky='nw', padx=(0, 10), pady=(4, 0))
        self.browser_label = ttk.Label(status, textvariable=self.browser_text, wraplength=820)
        self.browser_label.grid(row=1, column=1, sticky='w', pady=(4, 0))
        ttk.Label(self, textvariable=self.last_code, style='Big.TLabel').pack(anchor='w', pady=(12, 0))
        ttk.Label(self, textvariable=self.last_note, wraplength=900).pack(anchor='w')
        self.log = tk.Text(self, height=7, state='disabled', wrap='word', font=('Meiryo UI', 9), background='white', relief='solid', borderwidth=1)
        self.log.pack(fill='both', expand=True, pady=(10, 0))
        self._jobs = {'drain': self.after(100, self._drain), 'refresh': self.after(1000, self._refresh)}

    @property
    def running(self):
        return self.bridge.running

    def start(self, open_browser=False):
        if self.bridge.running:
            return
        reason = self.can_start()
        if reason:
            messagebox.showerror('読取りを開始できません', reason, parent=self)
            return
        try:
            self.bridge.start()
        except reader_bridge.BridgeError as error:
            self.reader_text.set(str(error))
            self.reader_label.configure(style='Warn.TLabel')
            messagebox.showerror('読取りを開始できません', str(error), parent=self)
            return
        self._write_log('読取りを開始しました。')
        self._buttons()
        if open_browser:
            self.open_screen()

    def stop(self):
        if not self.bridge.running:
            return
        self.bridge.stop()
        self.reader_text.set('読取りを止めました。')
        self.reader_label.configure(style='TLabel')
        self._write_log('読取りを止めました。')
        self._buttons()

    def open_screen(self):
        # ?reader=1 turns on "PCの読取機" in the rental screen; the screen removes it from the address.
        webbrowser.open(self.origin().strip().rstrip('/') + '/rental?reader=1')

    def destroy(self):
        self.bridge.stop()
        for job in self._jobs.values():
            self.after_cancel(job)
        super().destroy()

    def _buttons(self):
        running = self.bridge.running
        self.start_button.configure(state='disabled' if running else 'normal')
        self.stop_button.configure(state='normal' if running else 'disabled')
        self.on_change()

    def _write_log(self, text):
        self.log.configure(state='normal')
        self.log.insert('end', f'{datetime.now():%H:%M:%S}  {text}\n')
        self.log.see('end')
        self.log.configure(state='disabled')

    def _drain(self):
        try:
            while True:
                event = self.events.get_nowait()
                kind = event.get('kind')
                if kind == 'reader_state':
                    self.reader_text.set(event['text'])
                    self.reader_label.configure(style={'ready': 'Ok.TLabel', 'missing': 'Warn.TLabel', 'error': 'Warn.TLabel'}.get(event.get('state'), 'TLabel'))
                elif kind == 'reader_card':
                    self.last_code.set(f"No.{event['number']}" if event.get('number') else event['code'])
                    self.last_note.set(f"{event['code']} ／ {datetime.now():%H:%M:%S} に読み取り、物品画面へ渡しました。")
                    self._write_log(f"読取り: {event['text']}")
                    reader_bridge.beep(True)
                elif kind in ('reader_rejected', 'reader_undelivered'):
                    self.last_note.set(event['text'])
                    self._write_log(event['text'])
                    reader_bridge.beep(False)
        except queue.Empty:
            pass
        self._jobs['drain'] = self.after(100, self._drain)

    def _refresh(self):
        if self.bridge.running:
            connected, origin = self.bridge.browser()
            self.browser_text.set(f'物品画面とつながっています（{urlsplit(origin).hostname}）。' if connected else
                                  'まだつながっていません。「物品画面を開く」→ ログイン → 物品画面の「PCの読取機を使う」を押してください。')
            self.browser_label.configure(style='Ok.TLabel' if connected else 'Warn.TLabel')
        else:
            self.browser_text.set('—')
            self.browser_label.configure(style='TLabel')
        self._jobs['refresh'] = self.after(1000, self._refresh)


class ReaderWindow(tk.Tk):
    """Only the reading desk (物品読取.exe): no login, labels or card writing here."""

    def __init__(self, extra_origins=(), extra_card_origins=()):
        super().__init__()
        self.title('医薬祭 物品の読取り（貸出・返却）')
        self.geometry('760x600')
        self.minsize(620, 520)
        self.configure(background='#eef2f6')
        apply_styles(self)
        config = configuration()
        origin = config.get('origin', DEFAULT_ORIGIN)
        ttk.Label(self, text='物品の読取り（貸出・返却）', style='Title.TLabel').pack(anchor='w', padx=16, pady=(14, 0))
        self.panel = ReaderPanel(self, lambda: origin, reader_origins(config, extra_origins),
                                 reader_origins(config, extra_card_origins))
        self.panel.pack(fill='both', expand=True)
        self.after(300, lambda: self.panel.start(open_browser=True))


class App(tk.Tk):
    def __init__(self, initial_manifest=None, initial_excel=None, extra_origins=(), extra_card_origins=()):
        self.extra_origins, self.extra_card_origins = extra_origins, extra_card_origins
        super().__init__()
        self.title('医薬祭 物品ラベル・FeliCa書き込み r11')
        self.geometry('1100x760')
        self.minsize(940, 680)
        self.configure(background='#eef2f6')
        self.protocol('WM_DELETE_WINDOW', self.close)
        self.config_data = configuration()
        self.writer_disabled = ''
        self.server_history_required = bool(getattr(sys, 'frozen', False) or self.config_data.get('server_history_required', False))
        self.card_history_ready = False
        self.state_home = Path(sys.executable).parent if getattr(sys, 'frozen', False) else HERE
        try:
            self.state_dir = card_state.resolve_state(self.config_data, self.state_home, getattr(sys, 'frozen', False))
            card_state.activate(self.state_dir)
        except Exception as error:
            self.state_dir = None
            self.writer_disabled = '発行履歴を開けません。ZIPを展開し、発行履歴フォルダーも一緒に置いてください。\n' + str(error)
        self.events = queue.Queue()
        self.client = None
        self.controller = None
        self.items = []
        self.manifest = None
        self._start_manifest = None
        self.busy = False
        self.plan_source = None
        self.origin = tk.StringVar(value=self.config_data.get('origin', DEFAULT_ORIGIN))
        self.login_id = tk.StringVar()
        self.code = tk.StringVar()
        self.connection = tk.StringVar(value='未接続')
        self.force = tk.BooleanVar(value=False)
        self.force_skip = tk.BooleanVar(value=False)
        self.force_server_reset = tk.BooleanVar(value=False)
        self.reset_numbering = tk.BooleanVar(value=False)
        self.group = tk.StringVar()
        self.item_name = tk.StringVar()
        self.quantity = tk.StringVar(value='1')
        self.item_scope = tk.StringVar(value='区分未確認')
        self.first_number = tk.StringVar(value='100001')
        self.plan_status = tk.StringVar(value='団体・物品名・数量を登録してください')
        self.source_note = tk.StringVar(value='')
        self.bundle_status = tk.StringVar(value='書込み用データを選んでください')
        self.mode = tk.StringVar(value='sequence')
        self.input_code = tk.StringVar()
        self.start_code = tk.StringVar()
        self.single_touch = tk.BooleanVar(value=False)
        self._resume_available = False
        self.current_code = tk.StringVar(value='待機中')
        self.current_name = tk.StringVar(value='')
        self.card_status = tk.StringVar(value='印刷したラベルと対になった .issuance.json を開いてください。')
        self.next_action = tk.StringVar(value='書き込み用データを選んでください')
        self.progress_text = tk.StringVar(value='読戻し確認済み 0 枚')
        self.item_group = tk.StringVar(value='')
        self.overwrite_note = tk.StringVar(value='通常：空のカードに書き込みます')
        self.last_result = tk.StringVar(value='')
        self._input_ready = False
        self._stopping = False
        self._last_error = ''
        self._details_open = False
        self._log_open = False
        self.server_snapshot = None
        self.exact_server_items = None
        self.direct_items = None
        self.registration_mode = tk.StringVar(value='既存No.を維持して更新')
        self.server_note = tk.StringVar(value='ログインするとサーバーの台帳を読み込みます。')
        self.passed_codes = set()
        self._styles()
        self._layout()
        if self.writer_disabled:
            self.card_status.set(self.writer_disabled)
            self._buttons()
        self._buttons()
        self.after(80, self._drain)
        if initial_manifest:
            self.after(250, lambda: self.load_manifest(initial_manifest))
        if initial_excel:
            self.after(300, lambda: self.import_excel(initial_excel))

    def refresh_history_note(self):
        try:
            info = card_state.summary(self.state_dir) if self.state_dir else None
            if self.server_history_required and not self.card_history_ready:
                self.history_note.set('ログインして共通の発行履歴に接続してください。' if not self.client else 'サーバー更新・既存履歴の取り込みを確認してください。')
                return
            self.history_note.set(f"発行済み {info['passed']}枚 ／ 未完了 {info['reserved']}枚\n履歴はサーバーで共通管理しています。" if info else '発行履歴の保存先を開けません。')
        except Exception as error:
            self.history_note.set('発行履歴を確認できません。')
            self.writer_disabled = '発行履歴を確認できません。\n' + str(error)

    def history_dialog(self):
        if self.busy or self.writer_running():
            return
        window = tk.Toplevel(self)
        window.title('発行履歴・PCへの引き継ぎ')
        window.geometry('640x430')
        window.transient(self)
        window.grab_set()
        box = ttk.Frame(window, padding=20)
        box.pack(fill='both', expand=True)
        ttk.Label(box, text='発行履歴を引き継ぐ', style='Section.TLabel').pack(anchor='w')
        ttk.Label(box, textvariable=self.history_note, wraplength=590).pack(anchor='w', pady=(8, 12))
        ttk.Label(box, text='どのPCからも同じサーバー履歴を使います。別の物品は同時に発行できます。\n旧版の発行は停止し、旧履歴は最初の1回だけ取り込みます。', wraplength=590).pack(anchor='w', pady=(0, 12))
        actions = ttk.Frame(box)
        actions.pack(fill='x')
        def transfer(kind):
            try:
                if self.server_history_required and (not self.client or not getattr(self.client, 'card_history', None)):
                    raise trial.TrialError('ログインして共通発行履歴対応サーバーに接続してください。')
                if not self.state_dir or self.writer_running() or self.busy:
                    raise trial.TrialError('配布フォルダー全体と発行履歴を確認してください。処理中は引き継げません。')
                if kind == 'export':
                    path = filedialog.asksaveasfilename(parent=window, title='発行履歴をバックアップ', initialfile='発行履歴_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '.zip', defaultextension='.zip', filetypes=[('発行履歴ZIP', '*.zip')])
                    if not path:
                        return
                    if self.server_history_required:
                        self.client.card_history.backup(path)
                    else:
                        card_state.export_history(self.state_dir, path)
                    messagebox.showinfo('発行履歴を保存しました', '台帳と書き込み前後の証跡を保存しました。\n' + str(path), parent=window)
                else:
                    path = (filedialog.askdirectory(parent=window, title='旧版のcard、別PCの発行履歴、または配布フォルダーを選ぶ') if kind == 'folder' else filedialog.askopenfilename(parent=window, title='発行履歴ZIPを取り込む', filetypes=[('発行履歴ZIP', '*.zip')]))
                    if not path:
                        return
                    source = Path(path)
                    if source.is_dir() and not (source / card_state.REGISTRY).is_file() and (source / '発行履歴' / card_state.REGISTRY).is_file():
                        source = source / '発行履歴'
                    if not messagebox.askyesno('発行履歴を引き継ぐ', '取り込み元の発行を停止していることを確認してください。\n現在の履歴をバックアップしてから取り込みます。\n\n' + str(source), parent=window):
                        return
                    if self.server_history_required:
                        files = card_state.snapshot(source) if source.is_dir() else card_state.read_archive(source)
                        result = self.client.card_history.import_files(files)
                        result.update({'updated': True, 'backup': '元のPCの履歴はそのまま保管されています。'})
                        self.card_history_ready = result['initialized']
                    else:
                        result = card_state.import_history(self.state_dir, source)
                    self.refresh_history_note()
                    self._buttons()
                    messagebox.showinfo('引き継ぎを確認しました', ('新しい発行履歴を取り込みました。' if result['updated'] else '現在の履歴を保持しました。取り込み元は同じか、それより前の履歴です。') + '\n発行済み ' + str(result['passed']) + '枚 ／ 未完了 ' + str(result['reserved']) + '枚\n取り込み前の履歴：' + result['backup'], parent=window)
            except Exception as error:
                messagebox.showerror('発行履歴の操作を中止しました', str(error), parent=window)
        ttk.Button(actions, text='発行履歴をバックアップ（ZIP）', command=lambda: transfer('export')).pack(fill='x', pady=3)
        ttk.Button(actions, text='発行履歴ZIPを取り込む', command=lambda: transfer('zip')).pack(fill='x', pady=3)
        ttk.Button(actions, text='旧版・別PCのフォルダーから取り込む', command=lambda: transfer('folder')).pack(fill='x', pady=3)
        if self.server_history_required:
            def refresh():
                try:
                    if not getattr(self.client, 'card_history', None):
                        raise trial.TrialError('共通発行履歴対応サーバーへ更新し、ログインし直してください。')
                    state = self.client.card_history.read()
                    self.card_history_ready = state['initialized']
                    self.refresh_history_note()
                    self._buttons()
                except Exception as error:
                    messagebox.showerror('共通履歴を確認できません', str(error), parent=window)
            def recover():
                try:
                    if not getattr(self.client, 'card_history', None):
                        raise trial.TrialError('共通発行履歴対応サーバーへ更新し、ログインし直してください。')
                    state = self.client.card_history.read()
                    pending = state['active']
                    listing = '\n'.join(r['code'] + ' ／ ' + r['client'] + ' ／ ' + r['state'] for r in pending)
                    code = simpledialog.askstring('未完了の発行を引き継ぐ', '元PCの発行を安全に停止し、カードを回収してから操作します。\n引き継ぐ IY- から始まるコードを入力してください。\n\n' + (listing or '未完了の発行はありません。'), parent=window)
                    if not code:
                        return
                    matches = [r for r in pending if r['code'] == code.strip().upper()]
                    if len(matches) != 1:
                        raise trial.TrialError('一覧にある未完了のコードを指定してください。')
                    if not messagebox.askyesno('元PCの停止確認', '元PCの書き込みを安全に停止し、対象カードを回収していますか？\n割り当て・証跡は残ります。再発行時はカードの内容を確認し、必要な場合だけ上書きを許可します。', parent=window):
                        return
                    self.client.card_history.recover(matches[0]['id'])
                    refresh()
                except Exception as error:
                    messagebox.showerror('引継ぎを中止しました', str(error), parent=window)
            ttk.Button(actions, text='サーバーの履歴を読み直す', command=refresh).pack(fill='x', pady=3)
            ttk.Button(actions, text='未完了の発行を引き継ぐ', command=recover).pack(fill='x', pady=3)
            window.geometry('640x650')
        ttk.Label(box, text='保存先：' + str(self.state_dir or '未確認'), style='Hint.TLabel', wraplength=590).pack(anchor='w', pady=(12, 4))
        if self.state_dir:
            ttk.Button(box, text='発行履歴フォルダーを開く', command=lambda: os.startfile(str(self.state_dir))).pack(anchor='w')
        ttk.Button(box, text='閉じる', command=window.destroy).pack(side='bottom', anchor='e')

    def _styles(self):
        apply_styles(self)

    def _layout(self):
        outer = ttk.Frame(self, padding=(18, 12))
        outer.pack(fill='both', expand=True)
        header = ttk.Frame(outer)
        header.pack(fill='x', pady=(0, 10))
        ttk.Label(header, text='物品ラベル・FeliCa書き込み', style='Title.TLabel').pack(side='left')
        self.connection_label = ttk.Label(header, textvariable=self.connection, style='Hint.TLabel')
        self.connection_label.pack(side='right', padx=12)
        self.connection_toggle = ttk.Button(header, text='ログイン・接続先', command=self.toggle_connection)
        self.connection_toggle.pack(side='right')
        self.connection_box = ttk.Frame(outer, padding=(0, 0, 0, 12))
        self.connection_box.pack(fill='x')
        known = list(dict.fromkeys([*self.config_data.get('known_origins', []), *KNOWN_ORIGINS]))
        for col, text in enumerate(('接続先', '学籍番号 または iy- のログインID', 'パスワード')):
            ttk.Label(self.connection_box, text=text, style='Hint.TLabel').grid(row=0, column=col, sticky='w', pady=(0, 4))
        self.origin_entry = ttk.Combobox(self.connection_box, textvariable=self.origin, values=known, width=31)
        self.origin_entry.grid(row=1, column=0, sticky='ew', padx=(0, 12))
        self.login_entry = ttk.Entry(self.connection_box, textvariable=self.login_id, width=28)
        self.login_entry.grid(row=1, column=1, sticky='ew', padx=(0, 12))
        self.code_entry = ttk.Entry(self.connection_box, textvariable=self.code, show='●', width=18)
        self.code_entry.grid(row=1, column=2, sticky='ew', padx=(0, 12))
        self.code_entry.bind('<Return>', lambda _: self.connect())
        self.connect_button = ttk.Button(self.connection_box, text='ログイン', command=self.connect)
        self.connect_button.grid(row=1, column=3)
        self.connection_box.columnconfigure(0, weight=1)
        ttk.Label(self.connection_box, text='ラベルの新規発行時にログインします。発行済みデータのカード書き込みには不要です。', style='Hint.TLabel').grid(row=2, column=0, columnspan=4, sticky='w', pady=(5, 0))
        self.tabs = ttk.Notebook(outer)
        self.tabs.pack(fill='both', expand=True)
        self.plan_tab = ttk.Frame(self.tabs, padding=14)
        self.write_tab = ttk.Frame(self.tabs, padding=14)
        self.tabs.add(self.plan_tab, text='1  準備・ラベル印刷')
        self.tabs.add(self.write_tab, text='2  FeliCaに書き込む')
        self._plan_layout(self.plan_tab)
        self._write_layout(self.write_tab)
        self.reader_panel = ReaderPanel(self.tabs, lambda: self.origin.get(),
                                        reader_origins(self.config_data, self.extra_origins),
                                        reader_origins(self.config_data, self.extra_card_origins),
                                        can_start=lambda: 'カード書込みを停止してから、読取りを開始してください。' if self.writer_running() else '',
                                        on_change=self._buttons)
        self.tabs.add(self.reader_panel, text='貸出・返却の読取り')

    def toggle_connection(self):
        if self.connection_box.winfo_manager():
            self.connection_box.pack_forget()
        else:
            self.connection_box.pack(fill='x', before=self.tabs)
            self.code_entry.focus_set()

    def _plan_layout(self, tab):
        # Reserve the main action before the growing table, including at high DPI.
        footer = ttk.Frame(tab)
        footer.pack(side='bottom', fill='x', pady=(6, 0))
        self.issue_button = ttk.Button(footer, text='サーバー登録・ラベル発行', style='Primary.TButton', command=self.issue)
        self.issue_button.pack(side='left')
        self.pdf_button = ttk.Button(footer, text='PDFを開いて印刷', command=self.open_pdf, state='disabled')
        self.pdf_button.pack(side='left', padx=10)
        self.sheet_button = ttk.Button(footer, text='手書き用貸出表', command=self.open_loan_sheet, state='disabled')
        self.sheet_button.pack(side='left')
        ttk.Label(footer, text='A4・10面 ／ 91×55mm ／ 倍率100%', style='Hint.TLabel').pack(side='right')
        ttk.Label(tab, textvariable=self.plan_status).pack(side='bottom', anchor='w', pady=(6, 0))
        ttk.Label(tab, textvariable=self.source_note, style='Hint.TLabel', wraplength=950).pack(side='bottom', anchor='w', pady=(4, 0))
        import_row = ttk.Frame(tab)
        import_row.pack(fill='x')
        self.import_button = ttk.Button(import_row, text='物品リストのExcelを取り込む', style='Primary.TButton', command=self.import_excel)
        self.import_button.pack(side='left')
        if excel_import is None:
            self.import_button.state(['disabled'])
        self.irregular_button = ttk.Button(import_row, text='イレギュラーカードを作る', command=self.issue_irregular)
        self.irregular_button.pack(side='left', padx=8)
        self.manual_plan_toggle = ttk.Button(import_row, text='手入力・貼り付けを開く', command=self.toggle_manual_plan)
        self.manual_plan_toggle.pack(side='right')
        ttk.Label(tab, text='「物品まとめ」のExcelを取り込みます。原本のカード発行設定から、セット単位の枚数と券面の内訳を作成します。', style='Hint.TLabel', wraplength=850).pack(anchor='w', pady=(6, 0))
        server = ttk.Frame(tab)
        server.pack(fill='x', pady=(8, 0))
        self.server_read_button = ttk.Button(server, text='サーバーから読み出す', command=self.read_server)
        self.server_read_button.pack(side='left')
        self.registration_choice = ttk.Combobox(server, textvariable=self.registration_mode,
            values=('既存No.を維持して更新', '入力のNo.で上書き'), state='readonly', width=25)
        self.registration_choice.pack(side='left', padx=8)
        self.registration_choice.bind('<<ComboboxSelected>>', lambda _: (self.invalidate_preview(), self._buttons()))
        self.server_reset_button = ttk.Button(server, text='サーバーをリセット', command=self.reset_server)
        self.server_reset_button.pack(side='right')
        reset_options = ttk.Frame(tab)
        reset_options.pack(fill='x')
        self.force_server_reset_check = ttk.Checkbutton(reset_options, text='強制リセット（貸出中・要確認も含む）', variable=self.force_server_reset, command=self._buttons)
        self.force_server_reset_check.pack(side='right')
        numbering_options = ttk.Frame(tab)
        numbering_options.pack(fill='x')
        self.reset_numbering_check = ttk.Checkbutton(numbering_options, text='連番・番号予約・カード重複防止も初期化（No.100001から）', variable=self.reset_numbering)
        self.reset_numbering_check.pack(side='right')
        ttk.Label(tab, textvariable=self.server_note, style='Hint.TLabel', wraplength=850).pack(anchor='w', pady=(5, 0))
        self.manual_plan_box = ttk.Frame(tab)
        self.manual_plan_box.pack(fill='x')
        fields = ttk.Frame(self.manual_plan_box)
        fields.pack(fill='x', pady=(10, 8))
        ttk.Label(fields, text='貸出先の団体').grid(row=0, column=0, sticky='w')
        ttk.Label(fields, text='物品名').grid(row=0, column=1, sticky='w')
        ttk.Label(fields, text='数量').grid(row=0, column=2, sticky='w')
        self.group_entry = ttk.Combobox(fields, textvariable=self.group, width=28)
        self.group_entry.grid(row=1, column=0, sticky='ew', padx=(0, 8), pady=3)
        self.item_entry = ttk.Entry(fields, textvariable=self.item_name, width=32)
        self.item_entry.grid(row=1, column=1, sticky='ew', padx=(0, 8), pady=3)
        self.quantity_entry = ttk.Entry(fields, textvariable=self.quantity, width=7)
        self.quantity_entry.grid(row=1, column=2, padx=(0, 10), pady=3)
        self.add_button = ttk.Button(fields, text='一覧に追加', command=self.add_row)
        ttk.Label(fields, text='物品区分').grid(row=0, column=3, sticky='w')
        self.scope_entry = ttk.Combobox(fields, textvariable=self.item_scope, values=('学内','学外','委員会','区分未確認'), width=12, state='readonly')
        self.scope_entry.grid(row=1, column=3, padx=(0,8), pady=3)
        self.add_button.grid(row=1, column=4)
        fields.columnconfigure(0, weight=1)
        fields.columnconfigure(1, weight=1)
        ttk.Label(self.manual_plan_box, text='貼り付け：「団体名・物品名・数量・物品区分」の4列。3列でも使えます（区分未確認）。', style='Hint.TLabel', wraplength=850).pack(anchor='w', pady=(0, 5))
        self.plan_text = tk.Text(self.manual_plan_box, height=2, wrap='none', font=('Meiryo UI', 10), undo=True, relief='solid', borderwidth=1)
        self.plan_text.pack(fill='x')
        self.plan_text.bind('<<Modified>>', self._plan_changed)
        self.manual_plan_box.pack_forget()
        self.plan_actions = actions = ttk.Frame(tab)
        actions.pack(fill='x', pady=10)
        ttk.Label(actions, text='個体コードの開始番号').pack(side='left')
        self.number_entry = ttk.Entry(actions, textvariable=self.first_number, width=9)
        self.number_entry.pack(side='left', padx=8)
        self.first_number.trace_add('write', lambda *_: self.invalidate_preview())
        ttk.Button(actions, text='個体一覧を確認', command=self.preview).pack(side='left')
        ttk.Button(actions, text='予定一覧を開く', command=self.open_plan).pack(side='right')
        ttk.Button(actions, text='予定一覧を保存', command=self.save_plan).pack(side='right', padx=8)
        table_frame = ttk.Frame(tab)
        table_frame.pack(fill='both', expand=True)
        self.table = ttk.Treeview(table_frame, columns=('code', 'group', 'name', 'scope'), show='headings', height=6)
        for key, title, width in [('code','個体コード',160),('group','貸出予定の団体',270),('name','物品名',350),('scope','物品区分',100)]:
            self.table.heading(key, text=title)
            self.table.column(key, width=width, anchor='w')
        self.table.grid(row=0, column=0, sticky='nsew')
        scrollbar = ttk.Scrollbar(table_frame, orient='vertical', command=self.table.yview)
        scrollbar.grid(row=0, column=1, sticky='ns')
        horizontal = ttk.Scrollbar(table_frame, orient='horizontal', command=self.table.xview)
        horizontal.grid(row=1, column=0, sticky='ew')
        table_frame.rowconfigure(0, weight=1)
        table_frame.columnconfigure(0, weight=1)
        self.table.configure(yscrollcommand=scrollbar.set, xscrollcommand=horizontal.set)
        self.table.bind('<Double-1>', self.edit_selected_item)

    def toggle_manual_plan(self):
        if self.manual_plan_box.winfo_manager():
            self.manual_plan_box.pack_forget()
            self.manual_plan_toggle.configure(text='手入力・貼り付けを開く')
        else:
            self.manual_plan_box.pack(fill='x', before=self.plan_actions)
            self.manual_plan_toggle.configure(text='手入力・貼り付けを閉じる')

    def _write_layout(self, tab):
        # Setup stays at the left; the active item and the next physical action stay at the right.
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(0, weight=1)
        settings_width = max(284, tkfont.Font(font=('Meiryo UI', 10)).measure('使用済みカードへの上書きを許可') + 44)
        settings = ttk.Frame(tab, width=settings_width)
        settings.grid(row=0, column=0, sticky='nsew')
        settings.grid_propagate(False)
        settings.rowconfigure(0, weight=1)
        settings.columnconfigure(0, weight=1)
        self.settings_canvas = tk.Canvas(settings, highlightthickness=0, background='#f3f6f8', width=settings_width-16)
        self.settings_canvas.grid(row=0, column=0, sticky='nsew')
        settings_scroll = ttk.Scrollbar(settings, orient='vertical', command=self.settings_canvas.yview)
        self.settings_canvas.configure(yscrollcommand=settings_scroll.set)
        setup = ttk.Frame(self.settings_canvas, padding=(0, 0, 10, 8))
        settings_window = self.settings_canvas.create_window((0, 0), window=setup, anchor='nw')
        def resize_settings(_event=None):
            self.settings_canvas.itemconfigure(settings_window, width=self.settings_canvas.winfo_width())
            self.settings_canvas.configure(scrollregion=self.settings_canvas.bbox('all'))
            if setup.winfo_reqheight() > self.settings_canvas.winfo_height():
                settings_scroll.grid(row=0, column=1, sticky='ns', padx=(0, 6))
            else:
                settings_scroll.grid_remove()
                self.settings_canvas.yview_moveto(0)
        setup.bind('<Configure>', resize_settings)
        self.settings_canvas.bind('<Configure>', resize_settings)
        setup.columnconfigure(0, weight=1)
        ttk.Label(setup, text='書き込みの準備', style='Section.TLabel').grid(row=0, column=0, sticky='w')
        ttk.Label(setup, textvariable=self.bundle_status, style='Hint.TLabel', wraplength=254).grid(row=1, column=0, sticky='ew', pady=(8, 8))
        self.pick_button = ttk.Button(setup, text='書き込み用データを開く', command=self.pick_manifest)
        self.pick_button.grid(row=2, column=0, sticky='ew')
        self.prepare_button = ttk.Button(setup, text='新しくラベルを作る', command=lambda: self.tabs.select(self.plan_tab))
        self.prepare_button.grid(row=3, column=0, sticky='ew', pady=(6, 16))
        ttk.Separator(setup).grid(row=4, column=0, sticky='ew', pady=(0, 14))
        ttk.Label(setup, text='書き込む順番', style='Section.TLabel').grid(row=5, column=0, sticky='w')
        self.sequence_mode = ttk.Radiobutton(setup, text='印刷順に続けて書き込む', variable=self.mode, value='sequence', command=self.update_mode)
        self.sequence_mode.grid(row=6, column=0, sticky='w', pady=(8, 4))
        self.manual_mode = ttk.Radiobutton(setup, text='No.・QRで1枚ずつ指定する', variable=self.mode, value='manual', command=self.update_mode)
        self.manual_mode.grid(row=7, column=0, sticky='w')
        self.sequence_box = ttk.Frame(setup)
        self.sequence_box.grid(row=8, column=0, sticky='ew', pady=(12, 0))
        ttk.Label(self.sequence_box, text='開始・再開する No.', style='Hint.TLabel').pack(anchor='w')
        self.start_entry = ttk.Entry(self.sequence_box, textvariable=self.start_code, width=18)
        self.start_entry.pack(fill='x', pady=(4, 0))
        ttk.Label(self.sequence_box, text='停止時は続きのNo.を保持します。例：123', style='Hint.TLabel', wraplength=254).pack(anchor='w', pady=(3, 0))
        self.single_touch_check = ttk.Checkbutton(setup, text='ワンタッチ書込みを使う（任意）', variable=self.single_touch)
        self.single_touch_check.grid(row=12, column=0, sticky='w', pady=(12, 0))
        ttk.Label(setup, text='オフ：案内に従って離して再タッチ。\nオン：完了音までカードを置いたまま。', style='Hint.TLabel', wraplength=254).grid(row=13, column=0, sticky='w', pady=(3, 0))
        self.advanced_toggle = ttk.Button(setup, text='上書き設定を開く', command=self.toggle_overwrite)
        self.advanced_toggle.grid(row=9, column=0, sticky='ew', pady=(18, 5))
        self.advanced_box = ttk.Frame(setup)
        self.force_check = ttk.Checkbutton(self.advanced_box, text='使用済みカードへの上書きを許可', variable=self.force, command=self._force_changed)
        self.force_check.pack(anchor='w')
        self.force_skip_check = ttk.Checkbutton(self.advanced_box, text='毎回の上書き確認を省略する', variable=self.force_skip, command=self._buttons, state='disabled')
        self.force_skip_check.pack(anchor='w', pady=(6, 0))
        ttk.Label(self.advanced_box, text='許可した場合も、開始時に確認します。', style='Hint.TLabel', wraplength=254).pack(anchor='w', pady=(5, 0))
        self.history_button = ttk.Button(setup, text='発行履歴・PCへの引き継ぎ', command=self.history_dialog)
        self.history_button.grid(row=10, column=0, sticky='ew', pady=(14, 5))
        self.history_note = tk.StringVar()
        ttk.Label(setup, textvariable=self.history_note, style='Hint.TLabel', wraplength=254).grid(row=11, column=0, sticky='ew')
        self.refresh_history_note()
        work = ttk.Frame(tab, style='Work.TFrame', padding=(22, 16))
        work.grid(row=0, column=1, sticky='nsew')
        # Pack the action area first so it is always reachable when the window is small.
        action = ttk.Frame(work, style='Work.TFrame')
        action.pack(side='bottom', fill='x', pady=(12, 0))
        self.start_button = ttk.Button(action, text='書き込みを開始', style='Primary.TButton', command=self.start_writer)
        self.start_button.pack(side='left')
        self.stop_button = ttk.Button(action, text='安全に停止', command=self.stop_writer, state='disabled')
        self.stop_button.pack(side='left', padx=10)
        progress_row = ttk.Frame(work, style='Work.TFrame')
        progress_row.pack(side='bottom', fill='x')
        ttk.Label(progress_row, textvariable=self.progress_text, style='WorkHint.TLabel').pack(anchor='w', pady=(0, 5))
        self.progress = ttk.Progressbar(progress_row, mode='determinate')
        self.progress.pack(fill='x')
        ttk.Label(work, text='いま書き込む物品', style='WorkHint.TLabel').pack(anchor='w')
        self.number_label = ttk.Label(work, textvariable=self.current_code, style='Number.TLabel')
        self.number_label.pack(anchor='w', pady=(2, 0))
        self.group_label = ttk.Label(work, textvariable=self.item_group, style='Work.TLabel', wraplength=550)
        self.group_label.pack(anchor='w', pady=(0, 2))
        self.name_label = ttk.Label(work, textvariable=self.current_name, style='Item.TLabel', wraplength=550)
        self.name_label.pack(anchor='w')
        ttk.Separator(work).pack(fill='x', pady=12)
        self.next_label = ttk.Label(work, textvariable=self.next_action, style='Next.TLabel', wraplength=550)
        self.next_label.pack(anchor='w')
        self.status_label = ttk.Label(work, textvariable=self.card_status, style='Work.TLabel', wraplength=550, justify='left')
        self.status_label.pack(anchor='w', pady=(6, 8))
        self.scan_box = ttk.Frame(work, style='Work.TFrame')
        ttk.Label(self.scan_box, text='ラベルの No. または QRのURL', style='WorkHint.TLabel').pack(anchor='w')
        scan = ttk.Frame(self.scan_box, style='Work.TFrame')
        scan.pack(fill='x', pady=(4, 0))
        self.scan_entry = ttk.Entry(scan, textvariable=self.input_code)
        self.scan_entry.pack(side='left', fill='x', expand=True)
        self.scan_entry.bind('<Return>', lambda _: self.submit_code())
        self.scan_button = ttk.Button(scan, text='この物品に書き込む', command=self.submit_code)
        self.scan_button.pack(side='left', padx=(8, 0))
        self.last_result_label = ttk.Label(work, textvariable=self.last_result, style='WorkHint.TLabel', wraplength=550)
        self.last_result_label.pack(side='bottom', anchor='w', pady=(4, 6))
        record = ttk.Frame(tab)
        record.grid(row=1, column=0, columnspan=2, sticky='ew', pady=(8, 0))
        self.log_toggle = ttk.Button(record, text='詳しい記録を開く', command=self.toggle_log)
        self.log_toggle.pack(side='left')
        self.overwrite_label = ttk.Label(record, textvariable=self.overwrite_note, style='Hint.TLabel')
        self.overwrite_label.pack(side='left', padx=12)
        self.log = tk.Text(tab, height=4, state='disabled', wrap='word', font=('Meiryo UI', 9), background='white', relief='solid', borderwidth=1)
        self.log_scroll = ttk.Scrollbar(tab, orient='vertical', command=self.log.yview)
        self.log.configure(yscrollcommand=self.log_scroll.set)
        work.bind('<Configure>', lambda e: self._wrap_work(max(240, e.width - 44), e.height))
        self.update_mode()
        self.start_code.trace_add('write', lambda *_: self._apply_start_code())
        for event in ('<Return>', '<KP_Enter>', '<FocusOut>'):
            self.start_entry.bind(event, self._apply_start_code)

    def _wrap_work(self, width, height):
        for label in (self.group_label, self.name_label, self.next_label, self.status_label):
            label.configure(wraplength=width)
        compact = height < 470
        self.number_label.configure(style='CompactNumber.TLabel' if compact else 'Number.TLabel')
        self.name_label.configure(style='CompactItem.TLabel' if compact else 'Item.TLabel')
        if compact:
            self.last_result_label.pack_forget()
        elif not self.last_result_label.winfo_manager():
            self.last_result_label.pack(side='bottom', anchor='w', pady=(4, 6))

    def toggle_overwrite(self):
        self._details_open = not self._details_open
        if self._details_open:
            self.advanced_box.grid(row=10, column=0, sticky='ew', pady=(4, 0))
        else:
            self.advanced_box.grid_remove()
        self.advanced_toggle.configure(text='上書き設定を閉じる' if self._details_open else '上書き設定を開く')

    def toggle_log(self):
        self._log_open = not self._log_open
        if self._log_open:
            self.log.grid(row=2, column=0, columnspan=2, sticky='ew', pady=(6, 0), padx=(0, 16))
            self.log_scroll.grid(row=2, column=1, sticky='nse', pady=(6, 0))
        else:
            self.log.grid_remove()
            self.log_scroll.grid_remove()
        self.log_toggle.configure(text='詳しい記録を閉じる' if self._log_open else '詳しい記録を開く')

    def update_mode(self):
        manual = self.mode.get() == 'manual'
        running = self.writer_running()
        self.start_entry.configure(state='disabled' if manual or running or self.busy else 'normal')
        if manual:
            self.sequence_box.grid_remove()
        else:
            self.sequence_box.grid()
        enabled = manual and running and self._input_ready and not self._stopping
        self.scan_entry.configure(state='normal' if enabled else 'disabled')
        self.scan_button.configure(state='normal' if enabled else 'disabled')
        self.update_mode_controls()
        if not running and self.manifest:
            self._show_first_item()

    def _apply_start_code(self, event=None):
        # Enter confirms the preview; only the Start button enables card access.
        if not self.busy and not self.writer_running() and self.manifest and self.mode.get() == 'sequence':
            self._show_first_item()
        if event is not None and event.keysym in ('Return', 'KP_Enter'):
            return 'break'

    def _show_first_item(self):
        entries = getattr(self, 'bundle_items', [])
        if not entries:
            return
        if self.mode.get() == 'manual':
            self.current_code.set('No.で指定')
            self.current_name.set('開始後に、ラベルのNo.を入力します')
            self.item_group.set('')
            return
        code = self.start_code.get().strip()
        match = entries[0]
        if code:
            try:
                # Do not reopen/hash the entire PDF on every keystroke. Start
                # still validates the current files before any card is touched.
                resolved = writer_worker.resolve_manual_input(code, self._start_manifest)
                match = next(i for i in entries if i['code'] == resolved.code)
            except (OSError, ValueError, StopIteration, trial.TrialError):
                self.current_code.set('No.を確認')
                self.item_group.set('')
                self.current_name.set('一覧にあるNo.を入力してください')
                return
        self._show_item(match['code'])

    def _show_item(self, code, name=''):
        match = next((x for x in getattr(self, 'bundle_items', []) if x['code'] == code), {})
        number = str(int(code[3:]) - 100000) if code.startswith('IY-1') and code[3:].isdigit() else ''
        self.current_code.set(f'No.{number}' if number else code)
        group = match.get('borrower_name', '')
        scope = ' ／ '.join(filter(None, (match.get('item_scope', ''), match.get('item_owner', ''))))
        self.item_group.set(' ／ '.join(v for v in (group, scope, code) if v))
        self.current_name.set(name or match.get('name', ''))

    def _writer_event(self, event):
        kind, stage = event.get('kind'), event.get('stage')
        if event.get('code'):
            self._show_item(event['code'], event.get('name', ''))
        self._input_ready = kind == 'prompt' and stage == 'input'
        title, style = '処理しています。案内をお待ちください', 'Wait.TLabel'
        if kind == 'finished':
            self._stopping = False
            resume = event.get('resume_code')
            if self.mode.get() == 'sequence' and resume:
                self.start_code.set(resume)
                self._show_item(resume)
                self._resume_available = True
            if event.get('status') == 'passed':
                title, style = '今回の対象の確認がすべて完了しました', 'Success.TLabel'
            elif event.get('status') == 'failed':
                title, style = 'エラーで停止しました', 'Error.TLabel'
                if self._last_error:
                    self.card_status.set(self._last_error)
            else:
                title, style = '停止しました。次の物品には進んでいません', 'Wait.TLabel'
            if resume and self.mode.get() == 'sequence':
                title += f'。{self.current_code.get()}から再開できます'
        elif kind == 'error':
            title, style = ('書き込みを止めました。内容を確認してください' if event.get('fatal') else '入力したNo.を確認してください'), 'Error.TLabel'
            if event.get('fatal'):
                self._last_error = event.get('text', '')
        elif kind == 'ready':
            if self.mode.get() == 'sequence':
                self.start_code.set(event['code'])
                self._resume_available = True
            title, style = '表示されたNo.のラベルを貼ってください', 'Next.TLabel'
        elif stage == 'keep-still':
            title, style = 'カードを動かさず、完了音をお待ちください', 'Wait.TLabel'
        elif stage == 'input':
            title, style = 'ラベルのNo.を入力してください', 'Next.TLabel'
            if kind == 'error':
                style = 'Error.TLabel'
        elif stage in ('remove', 'remove-previous'):
            title, style = 'カードを読取機から離してください', 'Next.TLabel'
        elif stage in ('place', 'replace'):
            title, style = 'カードを1枚置いてください', 'Next.TLabel'
        elif stage == 'represent':
            title, style = '同じカードをもう一度置いてください', 'Next.TLabel'
        elif kind == 'confirm':
            title, style = '上書きする内容を確認してください', 'Wait.TLabel'
        elif kind == 'passed':
            title, style = 'このカードの確認ができました', 'Success.TLabel'
            self.last_result.set(f'直前の確認：{self.current_code.get()}  {self.current_name.get()}')
        elif self._stopping or event.get('stopping'):
            self._stopping = True
            title = '停止中です。読戻し確認を続けてください'
        self.next_action.set(title)
        self.next_label.configure(style=style)
        total = len(getattr(self, 'bundle_items', []))
        self.progress_text.set(f'この一覧で読戻し確認済み {len(self.passed_codes)} / {total} 枚')
        self.update_mode_controls()

    def update_mode_controls(self):
        enabled = self.mode.get() == 'manual' and self.writer_running() and self._input_ready and not self._stopping
        if enabled:
            self.scan_box.pack(fill='x', after=self.status_label, pady=(0, 8))
            if not self.scan_entry.instate(['!disabled']):
                self.scan_entry.after_idle(self.scan_entry.focus_set)
        else:
            self.scan_box.pack_forget()
        self.scan_entry.configure(state='normal' if enabled else 'disabled')
        self.scan_button.configure(state='normal' if enabled else 'disabled')

    def _plan_changed(self, _event=None):
        if self.plan_text.edit_modified():
            self.invalidate_preview()
            self.plan_text.edit_modified(False)

    def invalidate_preview(self):
        self.exact_server_items = None
        self.direct_items = None
        self.issue_button.configure(text='差分を確認して登録・発行')
        self.items = []
        self.plan_status.set('一覧を変更しました。「個体一覧を確認」で採番を確認してください')
        if hasattr(self, 'table'):
            self.table.delete(*self.table.get_children())

    def add_row(self):
        if self.busy or self.writer_running():
            return
        try:
            row = '\t'.join([self.group.get().strip(), self.item_name.get().strip(), self.quantity.get().strip(), self.item_scope.get()])
            workflow.parse_plan_tsv(row)
            self.plan_text.insert('end', row + '\n')
            self.item_name.set('')
        except Exception as e:
            self.error(e)

    def preview(self):
        if self.busy or self.writer_running():
            return False
        try:
            if self.direct_items is not None:
                self.items = [dict(i) for i in self.direct_items]
            elif self.exact_server_items is not None:
                self.items = [dict(i) for i in self.exact_server_items]
            else:
                rows = workflow.parse_plan_tsv(self.plan_text.get('1.0', 'end'))
                origin = self.client.item_origin if self.client else self.origin.get().strip().rstrip('/')
                snapshot = self.server_snapshot
                if snapshot is not None and self.registration_mode.get() != '入力のNo.で上書き':
                    previous = [i for i in workflow.catalog_label_items({'items': [i for i in snapshot['items'] if i.get('url')]}) if i.get('borrower_name')]
                    reserved = snapshot.get('reserved_through', 100000)
                    if previous:
                        result = reconcile.reconcile_rows(rows, previous, origin, reserved)
                        self.items = result['items']
                        self.server_note.set(f"既存No.を維持 {len(result['kept_codes'])}点 ／ 追加 {len(result['added_codes'])}点 ／ 今回の一覧にない既存物品 {len(result['removed_candidates'])}点（そのまま保持）")
                    else:
                        self.items = workflow.expand_rows(rows, origin, max(100001, reserved + 1, int(self.first_number.get())))
                else:
                    self.items = workflow.expand_rows(rows, origin, int(self.first_number.get()))
            self.show_plan_items()
            return bool(self.items)
        except Exception as e:
            self.items = []
            self.table.delete(*self.table.get_children())
            self.error(e)
            return False

    def show_plan_items(self):
        self.table.delete(*self.table.get_children())
        for item in self.items:
            scope = ' ／ '.join(filter(None, (item.get('item_scope', '区分未確認'), item.get('item_owner'))))
            self.table.insert('', 'end', values=(item['code'], item.get('borrower_name', '（予定なし）'), item['name'], scope))
        self.plan_status.set(f"{len(self.items)}個体" + (f" ／ {self.items[0]['code']} 〜 {self.items[-1]['code']}" if self.items else '。Excelを取り込んで新しい台帳を作れます。'))

    def edit_selected_item(self, _event=None):
        if self.busy or self.writer_running() or not self.table.selection():
            return
        code = self.table.item(self.table.selection()[0], 'values')[0]
        selected = next((i for i in self.items if i['code'] == code), None)
        if not selected:
            return
        dialog = tk.Toplevel(self)
        dialog.title(f'{code} を編集')
        dialog.transient(self)
        dialog.grab_set()
        panel = ttk.Frame(dialog, padding=18)
        panel.pack(fill='both', expand=True)
        ttk.Label(panel, text=code, style='Title.TLabel').grid(row=0,column=0,columnspan=2,sticky='w',pady=(0,12))
        fields = {}
        for row, (key, label) in enumerate((('name','物品名'),('borrower_name','貸出予定の団体'),('item_scope','物品区分'),('item_owner','借用元（学外物品）'),('url','カードのURL')), 1):
            ttk.Label(panel,text=label).grid(row=row,column=0,sticky='w',padx=(0,12),pady=6)
            var = fields[key] = tk.StringVar(value=selected.get(key,'区分未確認' if key == 'item_scope' else ''))
            if key == 'borrower_name':
                field = ttk.Combobox(panel,textvariable=var,values=self.group_entry.cget('values'),width=55)
            elif key == 'item_scope':
                field = ttk.Combobox(panel,textvariable=var,values=('学内','学外','委員会','区分未確認'),state='readonly')
            else:
                field = ttk.Entry(panel,textvariable=var,width=65)
            field.grid(row=row,column=1,sticky='ew',pady=6)
        ttk.Label(panel,text='ここでは編集内容を一覧に戻すだけです。サーバーへの反映は、差分を確認してから行います。',style='Hint.TLabel',wraplength=620).grid(row=6,column=0,columnspan=2,sticky='w',pady=10)
        def save():
            try:
                changed = {**selected,**{key:var.get().strip() for key,var in fields.items()}}
                if not changed['borrower_name']:
                    raise workflow.WorkflowError('貸出予定の団体を選んでください。')
                if changed['item_scope'] != '学外':
                    changed.pop('item_owner',None)
                elif not changed['item_owner']:
                    raise workflow.WorkflowError('学外物品の借用元を入力してください。')
                changed.pop('borrower_id',None)
                workflow._label_module().normalize_items([changed])
                values = [{**i} for i in self.items]
                values = [changed if i['code']==code else i for i in values]
                edited = {i['code']: i for i in self.direct_items or []}
                edited[code] = changed
                self.invalidate_preview()
                self.direct_items = list(edited.values())
                self.registration_mode.set('入力のNo.で上書き')
                self.items = values
                self.show_plan_items()
                self.source_note.set(f'{len(edited)}点を編集しました。差分確認とラベル再発行は編集したNo.だけが対象です。サーバーへの変更はまだ行っていません。')
                self._buttons()
                dialog.destroy()
            except Exception as error:
                self.error(error)
        ttk.Button(panel,text='一覧に反映',command=save,style='Primary.TButton').grid(row=7,column=1,sticky='e')
        self._edit_dialog, self._edit_fields, self._edit_save = dialog, fields, save

    def accept_server_state(self, snapshot, show_items=False):
        self.server_snapshot = snapshot
        available = self.client and 'issuer_management_v1' in self.client.capabilities
        self.server_note.set(f"サーバー台帳 {len(snapshot['items'])}点 ／ 保管済み {snapshot.get('archived_count', 0)}点" +
                             ('。変更前後を確認して反映できます。' if available else '。読出し対応。上書き・リセットにはサーバー側の更新が必要です。'))
        if show_items:
            self.plan_text.delete('1.0', 'end')
            if snapshot['items'] and all(i.get('borrower_name') for i in snapshot['items']):
                self.plan_text.insert('1.0', excel_plan_text([{**i,'quantity':1} for i in snapshot['items']]))
            self.plan_text.edit_modified(False)
            self.direct_items = None
            self.exact_server_items = [{k: v for k, v in i.items() if k in ('code', 'name', 'url', 'borrower_id', 'borrower_name', 'item_scope', 'item_owner', 'card_kind') and v is not None} for i in snapshot['items']]
            self.items = [dict(i) for i in self.exact_server_items]
            self.show_plan_items()
            self.issue_button.configure(text='読み出した台帳のラベルを保存')
            self.source_note.set('一覧の行をダブルクリックして編集できます。No.はそのまま使います。')
        self._buttons()

    def read_server(self):
        if self.busy or self.writer_running():
            return
        if not self.client:
            self.error('先に医薬祭アカウントでログインしてください。')
            return
        self.plan_status.set('サーバーの台帳を読み出しています…')
        self.run_job('server_read', self.client.server_state)

    def invalidate_card_bundle(self, reason):
        self.manifest = None
        self._resume_available = False
        self.bundle_items = []
        self.passed_codes.clear()
        self.pdf_button.configure(state='disabled')
        self.sheet_button.configure(state='disabled')
        self.current_code.set('待機中')
        self.current_name.set('')
        self.item_group.set('')
        self.card_status.set(reason)
        self.next_action.set('新しいラベルと書き込み用データを作成してください')
        self.bundle_status.set('サーバーの変更後は新しい発行データを使います')
        self.progress.configure(value=0)
        self.progress_text.set('読戻し確認済み 0 枚')
        self._buttons()

    def reset_server(self):
        if self.busy or self.writer_running() or not self.client:
            return
        self.plan_status.set('リセット対象を確認しています。まだ台帳は変更しません。')
        mode = 'force_reset_all' if self.force_server_reset.get() and self.reset_numbering.get() else 'force_reset' if self.force_server_reset.get() else 'reset'
        self.run_job('server_preview', lambda: {'preview': self.client.preview_changes(mode), 'items': [], 'target': None})

    def show_server_preview(self, result):
        preview = result['preview']
        mode = preview['mode']
        resetting = mode in ('reset', 'force_reset', 'force_reset_all')
        dialog = tk.Toplevel(self)
        dialog.title('連番・重複防止を含む初期化の確認' if mode == 'force_reset_all' else 'サーバーの強制リセット確認' if mode == 'force_reset' else 'サーバーのリセット確認' if resetting else 'サーバーの変更内容を確認')
        dialog.geometry('1050x680')
        dialog.minsize(860, 600)
        dialog.transient(self)
        dialog.grab_set()
        outer = ttk.Frame(dialog, padding=16)
        outer.pack(fill='both', expand=True)
        title = '連番・重複防止も初期化し、No.100001からやり直す' if mode == 'force_reset_all' else '貸出中も含め、台帳と貸出予定を空にする' if mode == 'force_reset' else '台帳と貸出予定を空にする' if resetting else '入力したNo.の情報を上書きする' if mode == 'overwrite' else '既存No.を維持して追加・更新する'
        ttk.Label(outer, text=title, style='Title.TLabel').pack(anchor='w')
        ttk.Label(outer, text=f"変更 {preview['changed_count']}点 ／ 変更なし {preview['unchanged_count']}点 ／ 変更不可 {preview['blocked_count']}点", style='Section.TLabel').pack(anchor='w', pady=(8, 4))
        ttk.Label(outer, text=preview['note'], wraplength=950).pack(anchor='w')
        if mode == 'force_reset_all':
            outstanding = preview.get('numbering_reset', {}).get('outstanding_claims', 0)
            ttk.Label(outer, text=f'未完了の発行予約 {outstanding}件も初期化します。全PCで発行を停止してください。', style='Warn.TLabel').pack(anchor='w', pady=(4, 0))
        if resetting and 'reset_counts' in preview:
            counts = preview['reset_counts']
            ttk.Label(outer, text=f"対象 {counts['total']}点のうち、貸出中 {counts['loaned']}点 ／ 要確認 {counts['review']}点", style='Warn.TLabel').pack(anchor='w', pady=(4, 0))
        ttk.Label(outer, text='物品名・URLを上書きした場合は、印刷済みのラベル・カードも対応を確認してください。' if mode == 'overwrite' else
                  '旧カード・QRも新しい登録先を開きます。カードと新しいラベルを必ず照合してください。' if mode == 'force_reset_all' else '旧No.は再利用しません。写真・発行履歴と実行前の状態はサーバーに保管します。' if resetting else
                  '一覧にない既存物品の削除・予定解除は行いません。', style='Hint.TLabel', wraplength=950).pack(anchor='w', pady=(4, 8))
        footer = ttk.Frame(outer)
        footer.pack(side='bottom', fill='x', pady=(10, 0))
        confirmation = tk.StringVar()
        required = preview.get('confirmation_code') or ('連番と重複防止を含めて初期化' if mode == 'force_reset_all' else '物品台帳を強制リセット' if mode == 'force_reset' else '物品台帳をリセット' if resetting else '上書きを実行' if mode == 'overwrite' else '変更を反映')
        ack = tk.BooleanVar(value=False)
        if mode == 'force_reset_all':
            ttk.Checkbutton(footer, text='全PCの発行を停止した。未完了の発行予約も退避して初期化する', variable=ack).pack(anchor='w')
        if resetting:
            short_code = bool(preview.get('confirmation_code'))
            ttk.Label(footer, text=f'確認番号： {required}' if short_code else f'確認のため「{required}」と入力',
                      font=('Meiryo UI', 16, 'bold') if short_code else ('Meiryo UI', 9)).pack(anchor='w')
            entry = ttk.Entry(footer, textvariable=confirmation, width=8 if short_code else 40)
            entry.pack(side='left', fill='x', expand=not short_code, padx=(0, 12))
            entry.focus_set()
        else:
            ttk.Checkbutton(footer, text='変更するNo.と内容を確認した', variable=ack).pack(side='left')
        def apply():
            if preview['blocked_count'] or (resetting and confirmation.get() != required) or (not resetting and not ack.get()) or (mode == 'force_reset_all' and not ack.get()):
                return
            dialog.destroy()
            def job():
                snapshot = self.client.apply_changes(preview['token'], required, all_writers_stopped=True) if mode == 'force_reset_all' else self.client.apply_changes(preview['token'], required)
                if mode == 'force_reset_all' and getattr(self.client, 'card_history', None):
                    self.client.card_history.read()
                wanted = {i['code'] for i in result['items']}
                labels = workflow.catalog_label_items({'items': [i for i in snapshot['items'] if i['code'] in wanted]})
                manifest = workflow.generate_bundle(labels, Path(result['target']), snapshot['reserved_through'], snapshot.get('ledger_generation', 0)) if result['target'] else None
                return {'snapshot': snapshot, 'labels': labels, 'manifest': str(manifest) if manifest else None, 'mode': mode}
            self.run_job('server_apply', job)
        apply_button = ttk.Button(footer, text='連番・重複防止も初期化する' if mode == 'force_reset_all' else '強制リセットを実行' if mode == 'force_reset' else 'リセットを実行' if resetting else '反映してラベルを保存', command=apply, style='Primary.TButton', state='disabled')
        apply_button.pack(side='right')
        ttk.Button(footer, text='キャンセル', command=dialog.destroy).pack(side='right', padx=8)
        def toggle(*_):
            allowed = not preview['blocked_count'] and (confirmation.get() == required if resetting else ack.get()) and (mode != 'force_reset_all' or ack.get())
            apply_button.configure(state='normal' if allowed else 'disabled')
        confirmation.trace_add('write', toggle)
        ack.trace_add('write', toggle)
        details = tk.Text(outer, height=4, wrap='word', state='disabled', font=('Meiryo UI', 9))
        details.pack(side='bottom', fill='x', pady=(8, 0))
        frame = ttk.Frame(outer)
        frame.pack(fill='both', expand=True)
        tree = ttk.Treeview(frame, columns=('code','field','before','after','blocked'), show='headings')
        columns = [('code','No.',110),('field','変更する項目',130),('before','現在',270),('after','反映後',270),('blocked','変更不可の理由',220)]
        for key, label, width in columns:
            tree.heading(key,text=label)
            tree.column(key,width=width,minwidth=80,stretch=False)
        vertical = ttk.Scrollbar(frame, orient='vertical', command=tree.yview)
        horizontal = ttk.Scrollbar(frame, orient='horizontal', command=tree.xview)
        tree.configure(yscrollcommand=vertical.set,xscrollcommand=horizontal.set)
        tree.grid(row=0,column=0,sticky='nsew')
        vertical.grid(row=0,column=1,sticky='ns')
        horizontal.grid(row=1,column=0,sticky='ew')
        frame.rowconfigure(0,weight=1)
        frame.columnconfigure(0,weight=1)
        names = {'name':'物品名','url':'カードのURL','borrower_name':'貸出予定の団体','item_scope':'物品区分','item_owner':'借用元','planned_state':'貸出予定','新規登録':'新規登録','台帳・貸出予定を保管':'リセット'}
        states = {'pending':'貸出前の予定あり', 'fulfilled':'貸出時に使用済み', 'unassigned':'予定なし'}
        for change in preview['changes']:
            before, after = change.get('before') or {}, change.get('after') or {}
            for field in change['fields'] or ['変更なし']:
                old = before.get(field, before.get('name', '—'))
                new = after.get(field, after.get('name', '保管' if resetting else '—'))
                if field in ('台帳・貸出予定を保管', '台帳・貸出予定・番号予約を初期化'):
                    status = {'ready': '貸出可能', 'loaned': '貸出中', 'borrowed': '貸出中', 'review': '要確認'}.get(before.get('status'), before.get('status', '不明'))
                    old = f"{before.get('name', '—')}（{status}／予定：{before.get('borrower_name') or 'なし'}）"
                    new = '退避して番号予約も解除' if mode == 'force_reset_all' else '保管（旧カード利用不可）'
                if field == 'planned_state':
                    old, new = states.get(old, old), states.get(new, new)
                tree.insert('', 'end', values=(change['code'], names.get(field,field), old if old is not None else '—', new if new is not None else '—', change.get('blocked') or ''))
        def select(_=None):
            chosen = tree.selection()
            if chosen:
                values = tree.item(chosen[0], 'values')
                details.configure(state='normal')
                details.delete('1.0','end')
                details.insert('1.0', f'{values[0]}  {values[1]}\n現在：{values[2]}\n反映後：{values[3]}' + (f'\n{values[4]}' if values[4] else ''))
                details.configure(state='disabled')
        tree.bind('<<TreeviewSelect>>',select)
        if tree.get_children():
            tree.selection_set(tree.get_children()[0])
            select()
        self._preview_dialog = dialog
        self._preview_apply_button = apply_button
        self._preview_confirmation = confirmation
        self._preview_ack = ack

    def connect(self):
        if self.busy or self.writer_running():
            return
        origin, login_id, secret = self.origin.get().strip().rstrip('/'), self.login_id.get().strip(), self.code.get()
        if not secret.strip():
            self.code_entry.focus_set()
            return
        self.code.set('')
        self.connection.set('接続中…')
        def job():
            client = workflow.ApiClient(origin)
            # The server tells which login it uses; credentials go only to the matching one.
            if client.detect() == 'account':
                if not login_id:
                    raise workflow.WorkflowError('統合アプリには学籍番号とパスワードでログインします。学籍番号を入力してください。')
                try:
                    client.login_account(login_id, secret)
                except workflow.WorkflowError as error:
                    raise workflow.WorkflowError(f'{error}\n\n学籍番号をまだ登録していない場合は、iy- で始まるログインID（Discord の DM に書かれた番号）で入ってください。学籍番号は統合アプリの「設定」で登録できます。') from None
            elif login_id:
                # A student ID typed for the earlier server: say which server this is instead of sending a password as a staff code.
                raise workflow.WorkflowError(f'{origin} は旧物品サーバー（スタッフコードでログイン）です。統合アプリへは接続先を {workflow.UNIFIED_ORIGIN} にしてください。旧物品サーバーを使うときは学籍番号を空欄にし、パスワード欄にスタッフコードを入れてください。')
            else:
                client.login(secret.strip())
            groups = client.borrowers()
            self.events.put({'kind': 'connection_state', 'text': 'ログイン済み・台帳を読込中…'})
            snapshot = client.server_state()
            if self.server_history_required and 'card_history_v1' in client.capabilities:
                client.card_history = server_history.ServerHistory(client, self.state_dir)
            return client, groups, snapshot
        self.run_job('connect', job)

    def issue_irregular(self):
        if self.busy or self.writer_running():
            return
        if not self.client or self.origin.get().strip().rstrip('/') != self.client.origin:
            self.error('先に貸出アプリへログインしてください。')
            return
        if 'irregular_cards_v1' not in self.client.capabilities:
            self.error('接続先がイレギュラーカードに未対応です。サーバーの更新後に使ってください。')
            return
        if not self.state_dir:
            self.error('発行履歴フォルダーを開けません。設定を確認してください。')
            return
        pending = self.state_dir / 'irregular-pending.json'
        initial = 10
        if pending.exists():
            try:
                initial = json.loads(pending.read_text(encoding='utf-8'))['count']
            except (ValueError, KeyError):
                self.error('前回の発行記録を読めません。履歴を消さず管理者へ確認してください。')
                return
        count = simpledialog.askinteger('イレギュラーカード', '作成枚数（1〜100枚）\n品名・数量・貸出先は手書きし、貸出時に入力します。\n全数返却後は別の物品へ再利用できます。', parent=self, initialvalue=initial, minvalue=1, maxvalue=100)
        if count is None:
            return
        filename = filedialog.asksaveasfilename(parent=self, title='イレギュラーカードの保存先', defaultextension='.pdf', filetypes=[('PDF','*.pdf')], initialfile=f'イレギュラーカード_{datetime.now():%Y%m%d_%H%M%S}.pdf')
        if not filename:
            return
        self.plan_status.set('イレギュラーカードを登録し、手書き用券面を保存しています…')
        self.run_job('irregular_issue', lambda: self.client.create_irregular_bundle(count, filename, pending))

    def issue(self):
        if self.busy or self.writer_running() or not self.preview():
            return
        if self.client is None or self.origin.get().strip().rstrip('/') != self.client.origin:
            self.error('貸出アプリに接続してください（統合アプリは学籍番号とパスワード、旧物品サーバーはスタッフコード）。')
            self.code_entry.focus_set()
            return
        filename = filedialog.asksaveasfilename(parent=self, title='ラベルPDFと書込み用データの保存先', defaultextension='.pdf', filetypes=[('PDF', '*.pdf')], initialfile=f'物品ラベル_{datetime.now():%Y%m%d_%H%M%S}.pdf')
        if not filename:
            return
        target = Path(filename)
        if target.exists() or target.with_suffix('.issuance.json').exists():
            self.error('既存のPDF・書込み用データを残すため、別のファイル名を指定してください。')
            return
        items = [dict(i) for i in self.items]
        client = self.client
        self.manifest = None
        self.bundle_items = []
        self.pdf_button.configure(state='disabled')
        self.sheet_button.configure(state='disabled')
        self.bundle_status.set('新しいラベルの発行が完了するまで書込みできません')
        self.plan_status.set('貸出予定を登録し、ラベルを作成しています…')
        if self.exact_server_items is not None:
            self.run_job('issue', lambda: (str(workflow.generate_bundle(items, target, self.server_snapshot.get('reserved_through', 0), self.server_snapshot.get('ledger_generation', 0))), items))
        elif 'issuer_management_v1' in client.capabilities:
            mode = 'overwrite' if self.registration_mode.get() == '入力のNo.で上書き' else 'update'
            self.run_job('server_preview', lambda: {'preview': client.preview_changes(mode, items), 'items': items, 'target': str(target)})
        else:
            if self.registration_mode.get() == '入力のNo.で上書き':
                self.error('上書きにはサーバー側の更新が必要です。「サーバーから読み出す」と既存ラベルの再発行は使えます。')
                self._buttons()
                return
            def job():
                registered = client.register(items)
                enriched = registered['items']
                manifest = workflow.generate_bundle(enriched, target, (self.server_snapshot or {}).get('reserved_through', 0), getattr(client, 'ledger_generation', 0))
                return str(manifest), enriched
            self.run_job('issue', job)

    def run_job(self, action, job):
        self.busy = True
        self._buttons()
        def worker():
            try:
                self.events.put({'kind':'job_done', 'action':action, 'value':job()})
            except Exception as e:
                self.events.put({'kind':'job_error', 'action':action, 'text':str(e)})
        threading.Thread(target=worker, daemon=True).start()

    def pick_manifest(self):
        if self.busy or self.writer_running():
            return
        path = filedialog.askopenfilename(parent=self, title='印刷PDFと対になる発行データ', filetypes=[('書込み用データ', '*.issuance.json')])
        if path:
            self.load_manifest(path)

    def load_manifest(self, path):
        if self.busy or self.writer_running():
            return False
        self.manifest = None
        self._start_manifest = None
        self.bundle_items = []
        self.bundle_status.set('書込み用データを確認しています…')
        self.pdf_button.configure(state='disabled')
        self.sheet_button.configure(state='disabled')
        try:
            entries = workflow.load_bundle(path)
            self._start_manifest = batch.load_manifest(path)
            self.manifest = Path(path).resolve()
            self.bundle_items = entries
            self.bundle_status.set(f'{len(entries)}枚分のデータ\n{self.manifest.name}')
            self.progress.configure(maximum=len(entries), value=0)
            self.passed_codes.clear()
            self.pdf_button.configure(state='normal')
            self.sheet_button.configure(state='normal')
            self.start_code.set('')
            self._resume_available = False
            if self.state_dir:
                saved = writer_worker.SequenceProgress(self.state_dir / '書込み進捗', self._start_manifest).read()
                self.passed_codes.update(saved['passed_codes'])
                if saved['next_code']:
                    self.start_code.set(saved['next_code'])
                    self._resume_available = True
                self.progress.configure(value=len(self.passed_codes))
            self._input_ready = self._stopping = False
            self._last_error = ''
            self.last_result.set('')
            self.progress_text.set(f'この一覧で読戻し確認済み {len(self.passed_codes)} / {len(entries)} 枚')
            self.next_action.set('準備できました。「書き込みを開始」を押してください')
            self.next_label.configure(style='Next.TLabel')
            self.card_status.set('印刷したラベルを手元に用意してください。開始後、表示されたNo.のラベルをカードに貼ります。')
            self.tabs.select(self.write_tab)
            self.connection_box.pack_forget()
            self._show_first_item()
            self._buttons()
            return True
        except Exception as e:
            self.bundle_status.set('確認に失敗しました。書込み用データを選び直してください')
            self.manifest = self._start_manifest = None
            self.next_action.set('書き込み用データを選び直してください')
            self.current_code.set('待機中')
            self.current_name.set('')
            self.item_group.set('')
            self._buttons()
            self.error(e)
            return False

    def open_pdf(self):
        if self.manifest:
            path = self.manifest.with_name(self.manifest.name[:-len('.issuance.json')] + '.pdf')
            os.startfile(str(path))

    def open_loan_sheet(self):
        # For when the system cannot be used: items per planned group with the label No.
        if not self.manifest or self.busy:
            return
        try:
            os.startfile(str(workflow.generate_loan_sheet(self.manifest)))
        except Exception as e:
            self.error(e)

    def start_writer(self):
        if not self.busy and not self.writer_running():
            try:
                state = card_state.resolve_state(self.config_data, self.state_home, getattr(sys, 'frozen', False))
                if state != self.state_dir:
                    raise trial.TrialError('発行履歴の保存先が変更されています。ソフトを開き直してください。')
            except Exception as error:
                self.writer_disabled = '発行履歴を確認できません。\n' + str(error)
                self._buttons()
        if self.busy or self.writer_running():
            return
        if self.server_history_required and (not self.client or not self.card_history_ready):
            self.error('ログインして共通の発行履歴に接続してください。')
            return
        if self.writer_disabled:
            self.error(self.writer_disabled)
            return
        if self.reader_panel.running:
            self.error('「貸出・返却の読取り」で読取機を使っています。読取りを停止してから書込みを開始してください。')
            return
        if not self.manifest:
            self.error('ラベルを発行するか、書込み用データを開いてください。')
            return
        force = self.force.get()
        skip = force and self.force_skip.get()
        if skip:
            title, question = '強制書き込みモード（確認なし）', (
                '置いたカードは、空でなくても、別の物品に割り当て済みでも、確認なしでそのまま上書きします。\n'
                '書込み禁止・鍵付き・容量不足のカードは上書きしません。上書き前の中身と外した割り当ては、証跡と発行台帳に残ります。\n'
                '上書きを記録した後は、古い版の発行ソフトではこの発行台帳を読めなくなります。\n\n'
                '読み取り機には、上書きしてよいカードだけを置いてください。確認なしの強制書き込みで開始しますか？')
        else:
            title, question = '強制書き込みモード', (
                '空でないカードや、別の物品に割り当て済みのカードも、1枚ずつ内容を確認したうえで上書きします。\n'
                '上書き前の中身は証跡に残ります。上書きを記録した後は、古い版の発行ソフトではこの発行台帳を読めなくなります。\n\n'
                '強制書き込みモードで開始しますか？')
        if force and not messagebox.askyesno(title, question, icon='warning', default='no', parent=self):
            return
        try:
            if self.mode.get() == 'sequence' and self.start_code.get().strip():
                selected = writer_worker.resolve_manual_input(self.start_code.get(), batch.load_manifest(self.manifest))
                self.start_code.set(selected.code)
            self._input_ready = self._stopping = False
            self._last_error = ''
            self.next_action.set('読取機に接続しています')
            self.next_label.configure(style='Wait.TLabel')
            self.controller = writer_worker.WriterController(str(self.manifest), self.events.put, force_overwrite=force, confirm_each=not skip,
                server_history=getattr(self.client, 'card_history', None),
                progress_folder=self.state_dir / '書込み進捗' if self.state_dir else None,
                single_touch=self.single_touch.get())
            start_code = (self.start_code.get().strip() or None) if self.mode.get() == 'sequence' else None
            self.controller.start(mode=self.mode.get(), start_code=start_code)
            self._buttons()
            if self.mode.get() == 'manual':
                self.scan_entry.focus_set()
        except Exception as e:
            self.error(e)

    def submit_code(self):
        value = self.input_code.get().strip()
        if value and self.writer_running() and self.mode.get() == 'manual':
            accepted = self.controller.submit_code(value)
            if accepted:
                self._input_ready = False
                self.update_mode_controls()
                self.input_code.set('')
            else:
                self.card_status.set('現在のカード処理が完了してから次のQR・コードを入力してください。')
            self.scan_entry.focus_set()

    def stop_writer(self):
        if self.controller:
            self._stopping = True
            self._input_ready = False
            self.controller.stop()
            self.stop_button.configure(state='disabled', text='停止中…')
            self.update_mode_controls()
            self.card_status.set('停止を受け付けました。進行中の書込み・読戻しを終えて停止します。')

    def writer_running(self):
        return bool(self.controller and self.controller.running)

    def _force_changed(self):
        # The "no confirmation" option exists only inside the forced mode.
        if not self.force.get():
            self.force_skip.set(False)
        self._buttons()

    def _buttons(self):
        locked = self.busy or self.writer_running()
        self.single_touch_check.configure(state='disabled' if locked else 'normal')
        self.start_button.configure(text='続きから再開' if self._resume_available and self.mode.get() == 'sequence' else '書き込みを開始')
        for button in (self.connect_button, self.issue_button, self.start_button):
            button.configure(state='disabled' if locked else 'normal')
        if self.writer_disabled or self.reader_panel.running or not self.manifest or (self.server_history_required and (not self.client or not self.card_history_ready)):
            self.start_button.configure(state='disabled')
        self.history_button.configure(state='disabled' if locked else 'normal')
        if self.writer_disabled:
            self.next_action.set('発行履歴を確認してください')
            self.card_status.set(self.writer_disabled)
            self.next_label.configure(style='Error.TLabel')
        elif self.server_history_required and (not self.client or not self.card_history_ready):
            self.next_action.set('ログイン・共通発行履歴への接続を確認してください')
            self.card_status.set('サーバーで履歴を共有し、同じNo.・カードの重複発行を防ぎます。')
        elif not locked and self.manifest and self.next_action.get() == 'ログイン・共通発行履歴への接続を確認してください':
            self.next_action.set('準備できました。「書き込みを開始」を押してください')
            self.card_status.set('サーバーの共通履歴に接続しました。印刷したラベルを手元に用意してください。')
        # One program at a time uses the RC-S370: card writing or reading for loans and returns.
        self.reader_panel.start_button.configure(state='disabled' if self.reader_panel.running or self.writer_running() else 'normal')
        self.origin_entry.configure(state='disabled' if locked or self.client else 'normal')
        self.stop_button.configure(state='normal' if self.writer_running() and not self._stopping else 'disabled', text='停止中…' if self._stopping else '安全に停止')
        self.pick_button.configure(state='disabled' if locked else 'normal')
        self.prepare_button.configure(state='disabled' if locked else 'normal')
        self.overwrite_note.set('上書き有効：毎回の確認なし' if self.force.get() and self.force_skip.get() else '上書き有効：1枚ずつ確認' if self.force.get() else '通常：空のカードに書き込みます')
        self.overwrite_label.configure(style='Warn.TLabel' if self.force.get() else 'Hint.TLabel')
        self.plan_text.configure(state='disabled' if locked else 'normal')
        for field in (self.group_entry, self.item_entry, self.quantity_entry, self.scope_entry, self.number_entry, self.add_button, self.import_button, self.irregular_button):
            field.configure(state='disabled' if locked else 'normal')
        self.scope_entry.configure(state='disabled' if locked else 'readonly')
        self.sequence_mode.configure(state='disabled' if locked else 'normal')
        self.manual_mode.configure(state='disabled' if locked else 'normal')
        self.force_check.configure(state='disabled' if locked else 'normal')
        self.force_skip_check.configure(state='disabled' if locked or not self.force.get() else 'normal')
        self.login_entry.configure(state='disabled' if locked or self.client else 'normal')
        available = bool(self.client and 'issuer_management_v1' in self.client.capabilities)
        self.server_read_button.configure(state='disabled' if locked or not self.client else 'normal')
        if self.exact_server_items is not None and any(not i.get('url') for i in self.exact_server_items):
            self.issue_button.configure(state='disabled')
            self.server_note.set('URL未発行の物品を含みます。Excelから貸出予定を登録してからラベルを作成してください。')
        self.registration_choice.configure(state='disabled' if locked else 'readonly')
        self.server_reset_button.configure(state='normal' if available and not locked and (self.server_snapshot or {}).get('reset_allowed') else 'disabled')
        force_reset_available = bool(available and 'issuer_force_reset_v1' in self.client.capabilities and (self.server_snapshot or {}).get('reset_allowed'))
        self.force_server_reset_check.configure(state='normal' if force_reset_available and not locked else 'disabled')
        if not force_reset_available:
            self.force_server_reset.set(False)
        numbering_available = bool(force_reset_available and 'issuer_numbering_reset_v1' in self.client.capabilities and self.force_server_reset.get())
        self.reset_numbering_check.configure(state='normal' if numbering_available and not locked else 'disabled')
        if not numbering_available:
            self.reset_numbering.set(False)
        if self.server_snapshot is not None and self.registration_mode.get() != '入力のNo.で上書き':
            self.number_entry.configure(state='disabled')
        self.update_mode_controls()
        self.start_entry.configure(state='disabled' if locked or self.mode.get() == 'manual' else 'normal')

    def _drain(self):
        try:
            while True:
                event = self.events.get_nowait()
                kind = event.get('kind')
                if kind == 'connection_state':
                    self.connection.set(event['text'])
                elif kind == 'job_done':
                    self.busy = False
                    if event['action'] == 'connect':
                        self.client, groups, snapshot = event['value']
                        self.card_history_ready = bool(getattr(self.client, 'card_history', None) and self.client.card_history.state['initialized'])
                        self.refresh_history_note()
                        who = f'・{self.client.user_name}' if self.client.user_name else ''
                        self.connection.set(f'接続済み（統合アプリ{who}）' if self.client.mode == 'account' else f'接続済み（旧物品サーバー{who}）')
                        self.invalidate_preview()
                        self.group_entry.configure(values=[x['name'] for x in groups])
                        self.connection_label.configure(style='Ok.TLabel')
                        self.connection_box.pack_forget()
                        self.accept_server_state(snapshot)
                    elif event['action'] == 'import':
                        self.show_excel_preview(event['value'])
                    elif event['action'] == 'server_read':
                        self.accept_server_state(event['value'], show_items=True)
                    elif event['action'] == 'server_preview':
                        self.show_server_preview(event['value'])
                    elif event['action'] == 'server_apply':
                        value = event['value']
                        self.invalidate_card_bundle('サーバーの台帳を変更しました。変更後のラベルと対になるデータを使ってください。')
                        self.accept_server_state(value['snapshot'], show_items=value['mode'] in ('reset', 'force_reset', 'force_reset_all'))
                        self.force_server_reset.set(False)
                        self.reset_numbering.set(False)
                        if value['manifest']:
                            self.load_manifest(value['manifest'])
                            self.plan_status.set(f"{len(value['labels'])}個体を反映し、ラベルを保存しました。")
                        else:
                            self.plan_status.set('連番と重複防止も初期化しました。旧履歴は退避済み。No.100001から再登録してください。' if value['mode'] == 'force_reset_all' else 'サーバー台帳と貸出予定をリセットしました。履歴・既発行No.は保管しています。')
                            if value['mode'] == 'force_reset_all':
                                self.refresh_history_note()
                            self.first_number.set(str(value['snapshot']['reserved_through'] + 1))
                    else:
                        path, entries = event['value']
                        self.load_manifest(path)
                        self.plan_status.set(f'{len(entries)}枚のイレギュラーカードを作成しました。PDFを100%で印刷し、対応データでカードへ書き込んでください。' if event['action'] == 'irregular_issue' else f'{len(entries)}個体の貸出予定を登録・ラベル発行しました。PDFを100%で印刷してください。')
                    self._buttons()
                elif kind == 'job_error':
                    self.busy = False
                    if event['action'] == 'connect':
                        self.connection.set('接続失敗')
                        self.connection_label.configure(style='Warn.TLabel')
                        self.client = None
                    elif event['action'] == 'import':
                        self.plan_status.set('Excelを取り込めませんでした。ファイルの形式を確認してください。')
                    elif event['action'] in ('server_preview', 'server_apply'):
                        self.plan_status.set('サーバーの変更を確認できませんでした。サーバーから読み直し、現在の台帳を確認してください。')
                    else:
                        self.plan_status.set('発行が完了しませんでした。登録状況を確認してから、同じ一覧で再実行してください。')
                    self._buttons()
                    self.error(event.get('text', '処理に失敗しました'))
                elif kind == 'confirm':
                    self._writer_event(event)
                    self.log.configure(state='normal')
                    self.log.insert('end', f'{datetime.now():%H:%M:%S}  上書きの確認: {event.get("code", "")}\n')
                    self.log.see('end')
                    self.log.configure(state='disabled')
                    self.bell()
                    answer = messagebox.askyesno('カードの上書き確認', event.get('text', ''), icon='warning', default='no', parent=self)
                    if self.controller:
                        self.controller.answer_overwrite(answer)
                    self.card_status.set('上書きして書き込みます。案内に従ってください。' if answer else '上書きを取り消しました。このカードには書き込みません。')
                else:
                    text = event.get('text', '')
                    if text:
                        if not (kind == 'finished' and event.get('status') == 'failed' and self._last_error):
                            self.card_status.set(text)
                        self.log.configure(state='normal')
                        self.log.insert('end', f'{datetime.now():%H:%M:%S}  {text}\n')
                        self.log.see('end')
                        self.log.configure(state='disabled')
                    if kind == 'passed' and event.get('code'):
                        self.passed_codes.add(event['code'])
                        self.progress.configure(value=len(self.passed_codes))
                        self.bell()
                    self._writer_event(event)
                    if kind == 'finished':
                        self.refresh_history_note()
                        self._buttons()
                    if kind == 'error':
                        self.bell()
        except queue.Empty:
            pass
        self.after(80, self._drain)

    def save_plan(self):
        if self.busy:
            return
        name = filedialog.asksaveasfilename(parent=self, defaultextension='.plan.json', filetypes=[('貸出予定', '*.plan.json')])
        if not name:
            return
        try:
            rows = workflow.parse_plan_tsv(self.plan_text.get('1.0','end'))
            with Path(name).open('x', encoding='utf-8') as stream:
                json.dump({'format':'rental-plan-v1','rows':rows,'start_number':int(self.first_number.get()),'origin':self.origin.get(),'source':self.plan_source}, stream, ensure_ascii=False, indent=2)
        except Exception as e:
            self.error(e)

    def open_plan(self):
        if self.busy or self.writer_running():
            return
        name = filedialog.askopenfilename(parent=self, filetypes=[('貸出予定', '*.plan.json')])
        if not name:
            return
        try:
            obj = json.loads(Path(name).read_text(encoding='utf-8'))
            if obj.get('format') != 'rental-plan-v1':
                raise ValueError('貸出予定ファイルの形式が違います。')
            text = excel_plan_text(obj['rows'])
            workflow.parse_plan_tsv(text)
            self.plan_text.delete('1.0','end')
            self.plan_text.insert('1.0',text)
            self.plan_source = obj.get('source')
            self.source_note.set('保存済みの予定一覧を開きました。取込後の手修正があれば入力内容を優先します。')
            self.first_number.set(str(obj['start_number']))
            # Loading a plan cannot silently switch an authenticated destination.
            if obj.get('origin', self.origin.get()) != self.origin.get():
                self.client = None
                self.connection.set('未接続')
                self.origin.set(obj['origin'])
                self._buttons()
            self.preview()
        except Exception as e:
            self.error(e)

    def import_excel(self, path=None):
        if self.busy or self.writer_running():
            return
        if excel_import is None:
            self.plan_status.set('この版には物品マスターのExcelの取り込みがありません。手入力・貼り付けで台帳を作ってください。')
            return
        if path is None:
            initial = {'initialdir':str(DEFAULT_EXCEL.parent),'initialfile':DEFAULT_EXCEL.name} if DEFAULT_EXCEL.is_file() else {}
            path = filedialog.askopenfilename(parent=self, title='医薬祭の物品リストを選ぶ',
                filetypes=[('Excel物品リスト', '*.xlsx *.xlsm'), ('すべてのファイル', '*.*')], **initial)
        if path:
            self.plan_status.set('Excelの団体名・貸出物品・個数を確認しています…')
            self.run_job('import', lambda: excel_import.read_workbook(path))

    def show_excel_preview(self, result):
        """Local preview only. Applying it neither registers nor writes a card."""
        sheets = result['sheets']
        supported = [s for s in sheets if s['selectable']]
        if not supported:
            details = '\n'.join(f"{s['sheet_name']}：{i['text']}" for s in sheets for i in s['issues'])
            self.error('取り込める貸出予定シートがありません。\n' + details[:1800])
            return
        dialog = tk.Toplevel(self)
        dialog.title('Excel取込の確認')
        dialog.geometry('1000x660')
        dialog.minsize(860, 560)
        dialog.transient(self)
        dialog.grab_set()
        outer = ttk.Frame(dialog, padding=14)
        outer.pack(fill='both', expand=True)
        one_sheet = result.get('selection_policy') == 'one_sheet'
        all_allowed = not one_sheet and result.get('all_selectable', True)
        choices = ([ALL_EXCEL_SHEETS] if all_allowed else []) + [s['sheet_name'] for s in supported]
        preferred = result.get('default_sheet')
        default_choice = ALL_EXCEL_SHEETS if preferred == '__all__' and all_allowed else preferred
        selected = tk.StringVar(value=default_choice if default_choice in choices else ('' if one_sheet else choices[0]))
        ack = tk.BooleanVar(value=False)
        append = tk.BooleanVar(value=False)
        include_master_code = tk.BooleanVar(value=one_sheet)
        summary = tk.StringVar()
        current = {'rows':[], 'issues':[], 'warnings':[], 'sheets':[]}
        footer = ttk.Frame(outer)
        footer.pack(side='bottom', fill='x', pady=(10, 0))
        def apply_import():
            if current['issues'] and not ack.get():
                return
            try:
                imported = excel_plan_text(current['rows'], include_master_code.get())
                old = self.plan_text.get('1.0','end').strip()
                text = old+'\n'+imported if append.get() and old and not one_sheet else imported
                workflow.parse_plan_tsv(text)
                # Replace only after validation, retaining Text undo history.
                self.plan_text.edit_separator()
                self.plan_text.delete('1.0','end')
                self.plan_text.insert('1.0',text)
                self.plan_text.edit_separator()
                self.plan_text.edit_modified(False)
                self.plan_source = {**result['source'], 'sheets':current['sheets'],
                    'card_templates':{s['sheet_name']:s.get('card_template','') for s in supported if s['sheet_name'] in current['sheets']},
                    'excluded':current['issues'], 'warnings':current['warnings'],
                    'imported_rows':current['rows'],
                    'master_codes_in_names':include_master_code.get(),
                    'selection_policy':result.get('selection_policy', 'multiple_sheets')}
                self.source_note.set(f"取込元：{result['source']['name']} ／ {len(current['sheets'])}シート ／ 要確認{len(current['issues'])}件を除外。手修正もできます。")
                self.preview()
                dialog.destroy()
            except Exception as e:
                messagebox.showerror('取込内容を確認してください', str(e), parent=dialog)
        apply_button = ttk.Button(footer, text='この内容を一覧に反映', style='Primary.TButton', command=apply_import)
        apply_button.pack(side='right')
        ttk.Button(footer, text='閉じる', command=dialog.destroy).pack(side='right', padx=10)
        if not one_sheet:
            ttk.Checkbutton(footer, text='現在の一覧に追加する', variable=append).pack(side='left')
        else:
            ttk.Label(footer, text='選んだ1シートで一覧を置き換えます。', style='Hint.TLabel').pack(side='left')
        ttk.Label(outer, text=result['source']['name'], font=('Meiryo UI',12,'bold'), wraplength=950).pack(anchor='w')
        ttk.Label(outer, text='取込はこの画面での確認だけです。ラベル発行は元の画面で行います。', style='Hint.TLabel').pack(anchor='w', pady=(4,8))
        if one_sheet:
            ttk.Label(outer, text='このマスターは1シートを選びます。別表とは合算しません。', style='Hint.TLabel').pack(anchor='w', pady=(0,6))
        choose = ttk.Combobox(outer, textvariable=selected, state='readonly', values=choices)
        choose.pack(fill='x')
        code_box = ttk.Checkbutton(outer, text='品目番号を物品名・ラベルに含める（例：[G1] 長机）', variable=include_master_code)
        code_box.pack(anchor='w', pady=(5,0))
        ttk.Label(outer, text='混在する物品は行を選び、学内・学外・委員会の数量を分けてください。区分は物品の所有元です。', style='Hint.TLabel').pack(anchor='w', pady=(5,0))
        ttk.Button(outer, text='選んだ行の物品区分・数量を指定', command=lambda: choose_scope()).pack(anchor='w', pady=(4,0))
        ttk.Label(outer, textvariable=summary).pack(anchor='w', pady=(8,6))
        # Keep issues and acknowledgement visible before the growing row table.
        ack_box = ttk.Checkbutton(outer, text='下の要確認セルを確認し、除外した内容を取り込む', variable=ack)
        ack_box.pack(side='bottom', anchor='w', pady=(5,0))
        issue_view = tk.Text(outer, height=4, state='disabled', wrap='word', font=('Meiryo UI',9), background='white', relief='solid', borderwidth=1)
        issue_view.pack(side='bottom', fill='x', pady=(8,0))
        ttk.Label(outer, text='要確認・除外・表記の調整', style='Hint.TLabel').pack(side='bottom', anchor='w', pady=(6,0))
        frame = ttk.Frame(outer)
        frame.pack(fill='both', expand=True)
        tree = ttk.Treeview(frame, columns=('group','master','name','qty','scope','cell'), show='headings', height=6)
        for key,title,width in [('group','団体',200),('master','品目番号',80),('name','物品・セット内容',350),('qty','カード枚数',85),('scope','物品区分',100),('cell','元のシート・セル',230)]:
            tree.heading(key,text=title)
            tree.column(key,width=width,anchor='w')
        tree.pack(side='left',fill='both',expand=True)
        scrollbar = ttk.Scrollbar(frame,orient='vertical',command=tree.yview)
        scrollbar.pack(side='right',fill='y')
        tree.configure(yscrollcommand=scrollbar.set)
        def choose_scope():
            selection = tree.selection()
            if not selection:
                return
            row = current['rows'][tree.index(selection[0])]
            popup = tk.Toplevel(dialog)
            popup.title('物品の区分と数量')
            popup.transient(dialog)
            popup.grab_set()
            panel = ttk.Frame(popup, padding=16)
            panel.pack(fill='both', expand=True)
            ttk.Label(panel, text=f"{row['borrower_name']}\n{row['name']}　合計{row['quantity']}個", wraplength=520).grid(row=0, column=0, columnspan=2, sticky='w', pady=(0,12))
            counts = {}
            for index, scope in enumerate(('学内','学外','委員会'), 1):
                ttk.Label(panel, text=scope+'物品').grid(row=index, column=0, sticky='w', padx=(0,16), pady=5)
                initial = row['quantity'] if row.get('item_scope') == scope else 0
                counts[scope] = tk.StringVar(value=str(initial))
                ttk.Entry(panel, textvariable=counts[scope], width=9).grid(row=index, column=1, sticky='w')
            message = tk.StringVar(value='3区分の合計を元の数量に合わせてください。')
            ttk.Label(panel, textvariable=message, wraplength=520).grid(row=4, column=0, columnspan=2, sticky='w', pady=10)
            def save():
                try:
                    pieces = workflow.split_scope_row(row, {key: value.get() for key,value in counts.items()})
                    for sheet in supported:
                        for index, candidate in enumerate(sheet['rows']):
                            if candidate is row:
                                sheet['rows'][index:index+1] = pieces
                                popup.destroy()
                                dialog.grab_set()
                                refresh()
                                return
                    raise workflow.WorkflowError('対象の行が変わりました。選び直してください。')
                except workflow.WorkflowError as error:
                    message.set(str(error))
            ttk.Button(panel, text='数量を分けて反映', command=save).grid(row=5, column=0, columnspan=2, sticky='e')
        tree.bind('<Double-1>', lambda _: choose_scope())
        def toggle(*_):
            total = sum(r['quantity'] for r in current['rows'])
            apply_button.configure(state='normal' if current['rows'] and total <= 10000 and (not current['issues'] or ack.get()) else 'disabled')
        def refresh(_=None):
            chosen = supported if all_allowed and selected.get() == ALL_EXCEL_SHEETS else [s for s in supported if s['sheet_name']==selected.get()]
            rows = [r for s in chosen for r in s['rows']]
            issues = [{'sheet_name':s['sheet_name'],**i} for s in chosen for i in s['issues']]
            warnings = [{'sheet_name':s['sheet_name'],**i} for s in chosen for i in s.get('warnings',[]) if i.get('kind') != 'unknown_scope' or any(r.get('item_scope') == '区分未確認' and r.get('source',{}).get('name_cell') == i.get('cell') for r in s['rows'])]
            current.update(rows=rows,issues=issues,warnings=warnings,sheets=[s['sheet_name'] for s in chosen])
            tree.delete(*tree.get_children())
            for row in rows:
                source = row.get('source',{})
                tree.insert('','end',values=(row['borrower_name'],source.get('master_item_code',''),row['name'],row['quantity'],row.get('item_scope','区分未確認'),f"{source.get('sheet_name','')}!{source.get('quantity_cell','')}"))
            has_codes = any(r.get('source',{}).get('master_item_code') for r in rows)
            code_box.configure(state='normal' if has_codes else 'disabled')
            total = sum(r['quantity'] for r in rows)
            excluded = len(sheets)-len(supported)
            unknown = sum(r['quantity'] for r in rows if r.get('item_scope') == '区分未確認')
            summary.set(f'{len(chosen)}シート・{len(rows)}行・カード{total}枚 ／ 区分未確認{unknown}枚 ／ 要確認{len(issues)}件 ／ 集計・テンプレート等{excluded}シートは対象外')
            if total > 10000:
                summary.set(summary.get() + '。1回10000個体までのためシートを分けてください。')
            details = '\n'.join(f"{i['sheet_name']}!{i.get('cell','')}：{i['text']}" + (f"（値：{i['value']}）" if 'value' in i else '') for i in issues) or '要確認セルはありません。'
            if warnings:
                details += '\n' + '\n'.join(f"表記調整：{i['sheet_name']}!{i.get('cell','')}：{i['text']}" for i in warnings)
            excluded_lines = [f"対象外：{s['sheet_name']} — {s.get('excluded_reason', '形式を読み取れません。')}" for s in sheets if not s['selectable']]
            if excluded_lines:
                details += '\n' + '\n'.join(excluded_lines)
            issue_view.configure(state='normal')
            issue_view.delete('1.0','end')
            issue_view.insert('1.0',details)
            issue_view.configure(state='disabled')
            ack.set(False)
            ack_box.configure(state='normal' if issues else 'disabled')
            toggle()
        ack.trace_add('write',toggle)
        choose.bind('<<ComboboxSelected>>',refresh)
        refresh()

    def error(self, error):
        messagebox.showerror('内容を確認してください', str(error), parent=self)

    def close(self):
        if self.busy:
            self.error('登録・ラベル作成の完了を待ってから閉じてください。')
            return
        self.reader_panel.stop()
        if self.writer_running():
            self.stop_writer()
            self.card_status.set('進行中の処理を終えてから閉じます。カードの読戻し確認を続けてください。')
            self.after(150, self._close_when_stopped)
            return
        self.destroy()

    def _close_when_stopped(self):
        if self.writer_running():
            self.after(150, self._close_when_stopped)
        else:
            self.destroy()


def reader_self_check():
    """The reading desk's browser service with a stand-in reader: no USB, nothing leaves this PC."""
    import urllib.error
    import urllib.request
    placed = threading.Event()
    standins = []

    class StandIn:
        def __init__(self, card, rejected, state, stop, check_url):
            self.card, self.state, self.stop, self.check_url = card, state, stop, check_url
            self.rejected = rejected; standins.append(self)

        def run(self):
            self.state('ready', 'self-check')
            if placed.wait(10):
                url = DEFAULT_ORIGIN + '/i/IY-100123'
                self.card(url, self.check_url(url), '0123456789ABCDEF')
            self.stop.wait()

    bridge = reader_bridge.ReaderBridge(lambda event: None, [DEFAULT_ORIGIN], [DEFAULT_ORIGIN], port=0, reader_factory=StandIn)
    bridge.start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def get(path, origin=DEFAULT_ORIGIN):
        request = urllib.request.Request(f'http://127.0.0.1:{bridge.port}{path}', headers={'Origin': origin} if origin else {})
        try:
            with opener.open(request, timeout=15) as response:
                return response.status, response.headers, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, error.headers, json.loads(error.read())
    try:
        assert get('/v1/status', origin=None)[0] == 403
        assert get('/v1/status', origin='https://example.com')[0] == 403
        status, headers, first = get('/v1/reads?client=self-check-0001&claim=1&wait=0')
        assert status == 200 and headers['Access-Control-Allow-Origin'] == DEFAULT_ORIGIN
        placed.set()
        status, _, body = get(f"/v1/reads?client=self-check-0001&after={first['seq']}&wait=10")
        assert status == 200 and [r['code'] for r in body['reads']] == ['IY-100123']
        snapshot = body
        timer = threading.Timer(0.05, lambda: standins[0].state('missing', 'self-check USB missing'))
        timer.start(); started = reader_bridge.time.monotonic()
        status, _, body = get(f"/v1/reads?client=self-check-0001&after={snapshot['seq']}&revision={snapshot['revision']}&event_after={snapshot['event_seq']}&wait=5")
        elapsed_ms = int((reader_bridge.time.monotonic()-started)*1000); timer.join()
        assert status == 200 and body['reader']['state'] == 'missing' and elapsed_ms < 2000
        standins[0].rejected('まだ書き込まれていないカードです。')
        status, _, feedback = get(f"/v1/reads?client=self-check-0001&after={body['seq']}&revision={body['revision']}&event_after={body['event_seq']}&wait=0")
        assert status == 200 and feedback['seq'] == snapshot['seq'] and feedback['reads'] == []
        assert feedback['events'][0]['text'] == 'まだ書き込まれていないカードです。'
        assert get('/v1/reads?client=self-check-0002&claim=1&wait=0')[0] == 200
        status, _, body = get('/v1/reads?client=self-check-0001&wait=0')
        assert status == 409 and body['code'] == 'taken_over'
    finally:
        bridge.stop()
    return {'refuses_other_pages': True, 'card_handed_to_screen': True, 'one_screen_at_a_time': True, 'state_change_ms': elapsed_ms, 'rejection_without_card_seq': True, 'usb_opened': False}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest')
    ap.add_argument('--reader', action='store_true', help='貸出・返却の読取りだけの画面を開く（物品読取.exe と同じ）')
    ap.add_argument('--excel', type=Path, help=argparse.SUPPRESS)
    ap.add_argument('--self-check', type=Path, help=argparse.SUPPRESS)
    # Local tests only: another rental screen origin / card URL origin the reading desk accepts.
    ap.add_argument('--reader-origin', action='append', default=[], help=argparse.SUPPRESS)
    ap.add_argument('--reader-card-origin', action='append', default=[], help=argparse.SUPPRESS)
    args = ap.parse_args()
    if args.self_check:
        # Packaging check only: no login, USB enumeration or card commands.
        import ctypes
        destination = args.self_check.resolve()
        destination.mkdir(parents=True, exist_ok=False)
        item = {'code':'IY-900001','name':'[G1] 実験用 Windows発行 延長コード',
                'url':DEFAULT_ORIGIN+'/i/IY-900001','borrower_name':'実験用 本部'}
        question = writer_worker.overwrite_text({'idm':'0123456789ABCDEF','code':item['code'],'name':item['name'],'url':item['url'],
            'existing_urls':['https://example.com/?iy=IY-TEST-000001'],'occupied':True,
            'conflicts':[{'kind':'card_bound','code':'IY-TEST-000001','url':'https://example.com/?iy=IY-TEST-000001','status':'passed'}]})
        assert item['code'] in question and 'IY-TEST-000001' in question and item['url'] in question
        summary = writer_worker.overwrite_summary({'idm':'0123456789ABCDEF','code':item['code'],'name':item['name'],'url':item['url'],
            'existing_urls':['https://example.com/?iy=IY-TEST-000001'],'occupied':True,
            'conflicts':[{'kind':'card_bound','code':'IY-TEST-000001','url':'https://example.com/?iy=IY-TEST-000001','status':'passed'}]})
        assert item['code'] in summary and 'IY-TEST-000001' in summary and '確認なし' in summary
        encoded = trial.encode_url(item['url'])
        assert trial.decode_url(encoded) == item['url']
        manifest = workflow.generate_bundle([item],destination/'団体付きラベル.pdf')
        loaded = workflow.load_bundle(manifest)
        assert loaded[0] == item
        card_manifest = batch.load_manifest(manifest)
        assert card_manifest.items[0].url == item['url']
        sheet = workflow.generate_loan_sheet(manifest)
        assert sheet.is_file() and sheet.read_bytes().startswith(b'%PDF')
        if getattr(sys,'frozen',False):
            ctypes.CDLL(str(Path(sys._MEIPASS)/'usb1/libusb-1.0.dll'))
        excel_check = {}
        if args.excel:
            assert excel_import is not None, 'this build has no Excel import'
            imported = excel_import.read_workbook(args.excel)
            supported = [s for s in imported['sheets'] if s['selectable']]
            selected_sheets = [s for s in supported if s['sheet_name'] == imported['default_sheet']] if imported.get('selection_policy') == 'one_sheet' else supported
            rows = [r for s in selected_sheets for r in s['rows']]
            workflow.parse_plan_tsv(excel_plan_text(rows, imported.get('selection_policy') == 'one_sheet'))
            excel_check = {'source_unchanged':imported['source']['unchanged'],
                'selection_policy':imported.get('selection_policy', 'multiple_sheets'),
                'selected_sheets':[s['sheet_name'] for s in selected_sheets],
                'supported_sheets':len(supported), 'rows':len(rows),
                'quantity':sum(r['quantity'] for r in rows),
                'issues':sum(len(s['issues']) for s in selected_sheets)}
            assert excel_check['source_unchanged']
        set_rows = workflow.prepare_set_rows([
            {'borrower_name':'自己診断','name':'横幕２Ｋ（委員会）','quantity':2,'item_scope':'委員会'},
            {'borrower_name':'自己診断','name':'横幕３Ｋ（委員会）','quantity':1,'item_scope':'委員会'},
            {'borrower_name':'自己診断','name':'テント ２K ×３K','quantity':4,'item_scope':'学内'}])
        set_items = workflow.expand_rows(workflow.parse_plan_tsv(excel_plan_text(set_rows)), DEFAULT_ORIGIN, 900101)
        assert len(set_items) == 5 and set_items[0]['name'].endswith('2K 2枚・3K 1枚')
        assert all(i['name'].endswith('1張分・1セット') for i in set_items[1:])
        set_manifest = workflow.generate_bundle(set_items,destination/'セット券面_自己診断.pdf')
        assert workflow.load_bundle(set_manifest) == set_items
        excel_check['set_cards_and_composition_roundtrip'] = True
        history_check = {}
        if getattr(sys, 'frozen', False):
            folder = card_state.resolve_state(configuration(), Path(sys.executable).parent)
            history_check = {'relative_to_executable': folder == Path(sys.executable).parent / '発行履歴', 'folder': str(folder), **card_state.summary(folder)}
            # Validate the actual Tk gate from the distributed EXE without any reader access.
            probe = App()
            probe.withdraw()
            try:
                if probe.server_history_required:
                    from types import SimpleNamespace
                    probe.client = SimpleNamespace(capabilities={'card_history_v1'})
                    probe.card_history_ready = True
                assert probe.load_manifest(manifest)
                assert not probe.start_button.instate(['disabled']), probe.writer_disabled
                history_check['start_enabled_with_manifest'] = True
                probe.start_entry.insert(0, 'INVALID')
                probe.start_entry.event_generate('<Return>')
                probe.update()
                assert probe.current_code.get() == 'No.を確認'
                probe.start_entry.delete(0, 'end')
                probe.start_entry.insert(0, item['code'])
                probe.start_entry.event_generate('<Return>')
                probe.update()
                assert probe.current_code.get() == item['code'] and probe.controller is None
                history_check['start_number_preview_without_focusout'] = True
                actual_state = probe.state_dir
                try:
                    # Synthetic resume files stay in the self-check output,
                    # never in the operator's issuance history.
                    probe.state_dir = destination / 'synthetic-history'
                    resume_items = [dict(item, code=f'IY-{100101+n}', url=DEFAULT_ORIGIN+f'/i/IY-{100101+n}') for n in range(2)]
                    resume_manifest = workflow.generate_bundle(resume_items, destination/'再開確認.pdf')
                    assert probe.load_manifest(resume_manifest)
                    probe._writer_event({'kind':'ready','code':resume_items[1]['code']})
                    probe._writer_event({'kind':'error','fatal':True,'text':'合成エラー'})
                    probe._writer_event({'kind':'finished','status':'failed','resume_code':resume_items[1]['code']})
                    probe._buttons()
                    assert probe.start_code.get() == resume_items[1]['code'] and probe.current_code.get() == 'No.102'
                    assert probe.start_button.cget('text') == '続きから再開'
                    assert not probe.single_touch.get()
                    assert not probe.single_touch_check.instate(['disabled'])
                    probe.single_touch_check.invoke()
                    assert probe.single_touch.get()
                    probe.single_touch_check.invoke()
                    assert not probe.single_touch.get()
                    writer_worker.SequenceProgress(probe.state_dir / '書込み進捗', probe._start_manifest).save(resume_items[1]['code'], [resume_items[0]['code']])
                    assert probe.load_manifest(resume_manifest)
                    assert probe.start_code.get() == resume_items[1]['code'] and probe.current_code.get() == 'No.102'
                    assert probe.passed_codes == {resume_items[0]['code']}
                    history_check.update(resume_after_error=True, resume_on_reopen=True,
                        single_touch_available=True, single_touch_default_off=True, single_touch_opt_in_toggle=True)
                finally:
                    probe.state_dir = actual_state
                from types import SimpleNamespace
                probe.client = SimpleNamespace(capabilities={'issuer_management_v1', 'issuer_force_reset_v1', 'issuer_numbering_reset_v1'},
                    preview_changes=lambda mode: {'mode': mode})
                probe.server_snapshot = {'items': [], 'reset_allowed': True}
                probe._buttons()
                assert not probe.force_server_reset.get()
                assert not probe.force_server_reset_check.instate(['disabled'])
                captured = []
                probe.run_job = lambda action, job: captured.append(job())
                probe.force_server_reset.set(True)
                probe.reset_server()
                assert captured[0]['preview']['mode'] == 'force_reset'
                assert probe.controller is None
                history_check['forced_reset_mode_without_server_write'] = True
                probe._buttons()
                assert not probe.reset_numbering.get()
                assert not probe.reset_numbering_check.instate(['disabled'])
                probe.reset_numbering.set(True)
                probe.reset_server()
                assert captured[-1]['preview']['mode'] == 'force_reset_all'
                history_check['numbering_reset_mode_without_server_write'] = True
                probe.show_server_preview({'preview': {'mode': 'force_reset_all', 'token': 'selfcheck-only',
                    'confirmation_code': '573', 'changed_count': 0, 'unchanged_count': 0,
                    'blocked_count': 0, 'note': '自己診断：本番接続・初期化なし', 'changes': []},
                    'items': [], 'target': None})
                probe._preview_dialog.withdraw()
                probe._preview_confirmation.set('連番と重複防止を含めて初期化')
                assert probe._preview_apply_button.instate(['disabled'])
                probe._preview_confirmation.set('573')
                assert probe._preview_apply_button.instate(['disabled'])
                probe._preview_ack.set(True)
                assert not probe._preview_apply_button.instate(['disabled'])
                probe._preview_dialog.destroy()
                history_check['three_digit_confirmation_without_server_write'] = True
            finally:
                probe.destroy()
        irregular_item = {'code':'IY-IR-900001','name':'イレギュラーカード','url':DEFAULT_ORIGIN+'/i/IY-IR-900001','card_kind':'irregular'}
        irregular_manifest = workflow.generate_bundle([irregular_item], destination/'イレギュラーカード_自己診断.pdf')
        assert workflow.load_bundle(irregular_manifest) == [irregular_item]
        irregular_cards = batch.load_manifest(irregular_manifest)
        assert writer_worker.resolve_manual_input('IR-900001', irregular_cards).url == irregular_item['url']
        history_check['irregular_label_manifest_manual_input'] = True
        reader_check = reader_self_check()
        (destination/'result.json').write_text(json.dumps({'status':'passed','frozen':bool(getattr(sys,'frozen',False)),
            'executable':Path(sys.executable).name,
            'pdf_and_manifest':True,'ndef_url_exact':True,'libusb_loaded':bool(getattr(sys,'frozen',False)),
            'excel':excel_check,'reader_bridge':reader_check,'card_history':history_check,'usb_opened':False,'device_written':False},indent=2),encoding='utf-8')
        return
    reader_only = args.reader or (getattr(sys, 'frozen', False) and Path(sys.executable).stem == READER_EXE)
    if reader_only:
        ReaderWindow(args.reader_origin, args.reader_card_origin).mainloop()
    else:
        App(args.manifest, args.excel, args.reader_origin, args.reader_card_origin).mainloop()


if __name__ == '__main__':
    if '--self-check' in sys.argv:
        # Headless verification must not wait behind PyInstaller's error dialog.
        try:
            main()
        except Exception:
            import traceback
            try:
                destination = Path(sys.argv[sys.argv.index('--self-check') + 1])
                destination.mkdir(parents=True, exist_ok=True)
                (destination/'error.txt').write_text(traceback.format_exc(),encoding='utf-8')
            finally:
                os._exit(1)
    else:
        main()
