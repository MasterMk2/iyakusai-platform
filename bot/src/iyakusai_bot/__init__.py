"""IyakusaiBot — 医薬祭実行委員会 Discord Bot。

設計は ../要件定義.md(v0.3)に従う:
- RPi / Windows 同一コード(§4.1)。ホスト差分は config.toml と secrets のみ
- データは共有ドライブが唯一の正。可変データは JSON
- lock.json + ハートビートで単一インスタンス保証
"""

__version__ = "0.1.0"
