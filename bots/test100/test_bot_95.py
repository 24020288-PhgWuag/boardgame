"""Baseline Python bot for the OTT V2 JSON Lines protocol."""

import json
import random
import sys


BEATS = {
    "rock": "scissors",
    "scissors": "paper",
    "paper": "rock",
}


def adjacent_moves(state, player):
    board = state["board"]
    moves = []

    for row, cells in enumerate(board):
        for col, piece in enumerate(cells):
            if not piece or piece["player"] != player:
                continue

            for row_delta in (-1, 0, 1):
                for col_delta in (-1, 0, 1):
                    if row_delta == 0 and col_delta == 0:
                        continue

                    target_row = row + row_delta
                    target_col = col + col_delta
                    if not 0 <= target_row < len(board):
                        continue
                    if not 0 <= target_col < len(board[target_row]):
                        continue

                    target = board[target_row][target_col]
                    if target and target["player"] == player:
                        continue
                    if target and target["type"] == piece["type"]:
                        continue

                    moves.append(
                        {
                            "from": {"row": row, "col": col},
                            "to": {"row": target_row, "col": target_col},
                            "capture": bool(target),
                            "wins_combat": bool(
                                target
                                and BEATS[piece["type"]] == target["type"]
                            ),
                        }
                    )

    return moves


def choose_move(message):
    player = message["player"]
    state = message["state"]
    moves = adjacent_moves(state, player)
    if not moves:
        return {"type": "error", "code": "NO_MOVE", "message": "No legal move found."}

    def move_weight(move):
        progress = (
            move["to"]["row"] + move["to"]["col"]
            if player == "p1"
            else (8 - move["to"]["row"]) + (8 - move["to"]["col"])
        )
        weight = 1.0 + progress * 0.25
        if move["wins_combat"]:
            weight += 8.0
        elif move["capture"]:
            weight *= 0.35
        return weight

    move = random.choices(moves, weights=[move_weight(move) for move in moves], k=1)[0]

    return {
        "protocol_version": 1,
        "type": "action",
        "action": {
            "type": "move",
            "from": move["from"],
            "to": move["to"],
        },
    }


def main():
    for line in sys.stdin:
        if not line.strip():
            continue

        try:
            message = json.loads(line)
            response = choose_move(message)
        except (KeyError, TypeError, ValueError) as error:
            response = {
                "type": "error",
                "code": "INVALID_REQUEST",
                "message": str(error),
            }

        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()

# test variant 95
TEST_ID = 95

