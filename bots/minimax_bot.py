"""Depth-limited minimax bot for the OTT V2 JSON Lines protocol."""

import copy
import json
import random
import sys


BOARD_SIZE = 9
TYPES = ("rock", "paper", "scissors")
BEATS = {
    "rock": "scissors",
    "scissors": "paper",
    "paper": "rock",
}
WIN_SCORE = 1_000_000


def opponent(player):
    return "p2" if player == "p1" else "p1"


def legal_moves(board, player):
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
                    if not 0 <= target_row < BOARD_SIZE:
                        continue
                    if not 0 <= target_col < BOARD_SIZE:
                        continue

                    target = board[target_row][target_col]
                    if target and target["player"] == player:
                        continue
                    if target and target["type"] == piece["type"]:
                        continue

                    moves.append({
                        "from": {"row": row, "col": col},
                        "to": {"row": target_row, "col": target_col},
                    })
    return moves


def apply_move(board, player, move):
    next_board = copy.deepcopy(board)
    source = move["from"]
    target = move["to"]
    attacker = next_board[source["row"]][source["col"]]
    defender = next_board[target["row"]][target["col"]]

    if defender and BEATS[attacker["type"]] != defender["type"]:
        next_board[source["row"]][source["col"]] = None
        result = "defeat"
    else:
        next_board[target["row"]][target["col"]] = attacker
        next_board[source["row"]][source["col"]] = None
        result = "capture" if defender else "move"

    return next_board, result


def count_types(board, player):
    counts = {piece_type: 0 for piece_type in TYPES}
    total = 0
    for row in board:
        for piece in row:
            if piece and piece["player"] == player:
                counts[piece["type"]] += 1
                total += 1
    counts["total"] = total
    return counts


def winner_after_move(board, player, move):
    row = move["to"]["row"]
    col = move["to"]["col"]
    if player == "p1" and (row, col) == (8, 8):
        return "p1"
    if player == "p2" and (row, col) == (0, 0):
        return "p2"

    own = count_types(board, player)
    other_player = opponent(player)
    other = count_types(board, other_player)
    other_wiped = any(other[piece_type] == 0 for piece_type in TYPES)
    own_wiped = any(own[piece_type] == 0 for piece_type in TYPES)
    if other_wiped and not own_wiped:
        return player
    if own_wiped and not other_wiped:
        return other_player
    if other_wiped and own_wiped:
        return player
    return None


def evaluate(board, perspective):
    other_player = opponent(perspective)
    score = 0

    for player, multiplier in ((perspective, 1), (other_player, -1)):
        counts = count_types(board, player)
        score += multiplier * counts["total"] * 120
        score += multiplier * sum(counts[piece_type] for piece_type in TYPES) * 10

        for row, cells in enumerate(board):
            for col, piece in enumerate(cells):
                if not piece or piece["player"] != player:
                    continue
                progress = row + col if player == "p1" else 16 - row - col
                score += multiplier * progress * 3

    return score


def move_order(board, player, move):
    source = move["from"]
    target = move["to"]
    attacker = board[source["row"]][source["col"]]
    defender = board[target["row"]][target["col"]]
    score = 0

    if defender:
        score += 10_000 if BEATS[attacker["type"]] == defender["type"] else -2_000
    progress = target["row"] + target["col"] if player == "p1" else 16 - target["row"] - target["col"]
    score += progress
    return score


def minimax(board, turn, perspective, depth, alpha, beta, last_move=None):
    if last_move is not None:
        winner = winner_after_move(board, opponent(turn), last_move)
        if winner:
            return WIN_SCORE if winner == perspective else -WIN_SCORE

    if depth == 0:
        return evaluate(board, perspective)

    moves = legal_moves(board, turn)
    if not moves:
        return evaluate(board, perspective)
    moves.sort(key=lambda move: move_order(board, turn, move), reverse=True)

    maximizing = turn == perspective
    if maximizing:
        best = -WIN_SCORE
        for move in moves:
            next_board, _ = apply_move(board, turn, move)
            best = max(
                best,
                minimax(next_board, opponent(turn), perspective, depth - 1, alpha, beta, move),
            )
            alpha = max(alpha, best)
            if beta <= alpha:
                break
        return best

    best = WIN_SCORE
    for move in moves:
        next_board, _ = apply_move(board, turn, move)
        best = min(
            best,
            minimax(next_board, opponent(turn), perspective, depth - 1, alpha, beta, move),
        )
        beta = min(beta, best)
        if beta <= alpha:
            break
    return best


def choose_move(message):
    player = message["player"]
    board = message["state"]["board"]
    moves = legal_moves(board, player)
    if not moves:
        return {"type": "error", "code": "NO_MOVE", "message": "No legal move found."}

    depth = 3 if len(moves) <= 24 else 2
    moves.sort(key=lambda move: move_order(board, player, move), reverse=True)
    best_score = -WIN_SCORE
    best_moves = []

    for move in moves:
        next_board, _ = apply_move(board, player, move)
        score = minimax(
            next_board,
            opponent(player),
            player,
            depth - 1,
            -WIN_SCORE,
            WIN_SCORE,
            move,
        )
        if score > best_score:
            best_score = score
            best_moves = [move]
        elif score == best_score:
            best_moves.append(move)

    best_move = random.choice(best_moves)

    return {
        "protocol_version": 1,
        "type": "action",
        "action": {
            "type": "move",
            "from": best_move["from"],
            "to": best_move["to"],
        },
    }


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            response = choose_move(json.loads(line))
        except (KeyError, TypeError, ValueError) as error:
            response = {
                "type": "error",
                "code": "INVALID_REQUEST",
                "message": str(error),
            }
        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
