"""Initialize a fresh RECEPT SQLite database without overwriting existing data."""

import argparse
from contextlib import closing
import os
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, nargs="?",
                        default=Path(os.environ.get("RECEPT_DB", "data/recept.sqlite3")))
    path = parser.parse_args().database
    if path.suffix != ".sqlite3":
        parser.error("DBファイルの拡張子には .sqlite3 を指定してください。")

    schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = path.parent.stat()
    if os.name == "posix" and (directory.st_uid != os.getuid() or directory.st_mode & 0o022):
        parser.error("DBは、起動ユーザーが所有し他のユーザーが書き込めないディレクトリに置いてください。")
    try:
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    except FileExistsError:
        parser.exit(1, "既存DBの上書きを拒否しました。別のファイル名を指定してください。\n")

    try:
        with closing(sqlite3.connect(path)) as connection:
            connection.executescript(schema)
    except Exception:
        path.unlink()
        raise
    print(f"SQLite DBを初期化しました。 {path}")


if __name__ == "__main__":
    main()
