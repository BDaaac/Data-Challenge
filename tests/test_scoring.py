import json, unittest
from pathlib import Path
from app.engine import score
from app.analytics import criterion_losses

class Scoring(unittest.TestCase):
    def setUp(self):
        self.criteria=json.loads(Path("config/checklists/chat.v1.json").read_text(encoding="utf-8"))["criteria"]
        self.good={"c1":"yes","c2":"yes","c3":"yes","c4":"20","c5":"yes","c6":"10","c7":"yes","c8":"no"}
    def test_full_na_and_flag(self):
        self.assertEqual(score(self.criteria,self.good)["total"],100)
        self.assertEqual(score(self.criteria,{**self.good,"c2":"na","c3":"na"})["total"],100)
        self.assertEqual(score(self.criteria,{**self.good,"c8":"yes"})["total"],100)
        self.assertEqual(score(self.criteria,{**self.good,"c1":"no"})["total"],90)
        self.assertEqual(score(self.criteria,{**self.good,"c6":"4"})["total"],91)
    def test_losses_use_historical_weights(self):
        rows=[{"id":"a","eval_id":1,"checklist_id":2}]
        items=[{"eval_id":1,"crit_id":k,"answer":v} for k,v in self.good.items()]
        cl={2:{"id":2,"version":1,"criteria":self.criteria}}
        self.assertEqual(sum(x["points"] for x in criterion_losses(rows,items,cl)),0)
        items[0]["answer"]="no"
        self.assertEqual(sum(x["points"] for x in criterion_losses(rows,items,cl)),10)
