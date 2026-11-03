"""Summary tests with synthetic tasks: no Discord, secrets or production DB."""
import datetime as dt
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("summary_gateway", Path(__file__).with_name("bot_task_gateway.py"))
api = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = api
spec.loader.exec_module(api)
DEPTS = {"naimu": ("内務部", None), "kikaku": ("企画課", "naimu"), "kaijo": ("会場課", "naimu"), "gaimu": ("外務部", None), "koho": ("広報課", "gaimu")}
NOW = dt.datetime(2026, 10, 13, 15, tzinfo=dt.timezone.utc)
def task(number, deadline=None, tags=("kikaku",), status="todo"):
    return types.SimpleNamespace(task=types.SimpleNamespace(number=number, deadline=deadline, tags=tags, status=status))

class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.store = types.SimpleNamespace(list_tasks=Mock(return_value=[]))
        self.gateway = api.SqliteGateway(types.SimpleNamespace(DEPARTMENTS=DEPTS), self.store)
        self.context = types.SimpleNamespace(authorize=Mock(), scope=Mock(return_value="synthetic-scope"))
    def test_japanese_midnight_and_all_deadline_boundaries(self):
        self.store.list_tasks.return_value = [task(1,"2026-10-13"), task(2,"2026-10-14"), task(3,"2026-10-15",status="in_progress"), task(4,"2026-10-16",status="blocked"), task(5,"2026-10-21"), task(6,"2026-10-22"), task(7), task(8,"2026-10-13",status="done")]
        s = self.gateway.summary(self.context, NOW)
        self.assertEqual(s["today"], "2026-10-14")
        self.assertEqual(s["total"], 7)
        self.assertEqual(s["deadlines"], dict(overdue=1,today=1,tomorrow=1,upcoming=2,later=1,none=1))
        self.assertEqual([x["remaining"] for x in s["byDate"]], [1]*6)
        self.context.authorize.assert_called_once_with(None,"viewer")
        self.store.list_tasks.assert_called_once_with("synthetic-scope")
    def test_parent_and_multi_tag_do_not_double_count(self):
        self.store.list_tasks.return_value = [task(1,tags=("kikaku","kaijo","naimu","koho"))]
        s = self.gateway.summary(self.context, NOW)
        self.assertEqual(s["total"], 1)
        self.assertEqual([d["remaining"] for d in s["departments"]], [1,1,1,1,1])
        self.assertEqual(s["departments"][1]["parentId"], "dept-naimu")
    def test_denied_access_does_not_read_counts(self):
        self.context.authorize.side_effect = api.ApiError(404,"NOT_FOUND")
        with self.assertRaises(api.ApiError): self.gateway.summary(self.context, NOW)
        self.store.list_tasks.assert_not_called()
    def test_no_tasks_is_real_zero(self):
        s = self.gateway.summary(self.context, NOW)
        self.assertEqual(s["total"],0)
        self.assertEqual(s["byDate"],[])
        self.assertEqual(sum(s["deadlines"].values()),0)
    def test_too_many_tasks_fails_instead_of_partial_counts(self):
        self.store.list_tasks.return_value = [task(n) for n in range(2001)]
        with self.assertRaises(api.ApiError) as e: self.gateway.summary(self.context,NOW)
        self.assertEqual(e.exception.status,503)
    def test_upstream_failure_does_not_become_zero(self):
        self.store.list_tasks.side_effect = RuntimeError("synthetic failure")
        with self.assertRaises(RuntimeError): self.gateway.summary(self.context,NOW)
    def test_dispatch_does_not_allow_unsigned_scope_overrides(self):
        self.gateway.summary = Mock(return_value={"total":3})
        self.assertEqual(self.gateway.dispatch("GET","/api/integration/v1/summary",{},self.context),(200,{"total":3}))
        with self.assertRaises(api.ApiError): self.gateway.dispatch("GET","/api/integration/v1/summary?actor=other",{},self.context)
    def test_a_day_before_midnight_still_uses_previous_japanese_date(self):
        before = NOW-dt.timedelta(seconds=1)
        self.store.list_tasks.return_value = [task(1,"2026-10-13"),task(2,"2026-10-14")]
        s = self.gateway.summary(self.context,before)
        self.assertEqual(s["today"],"2026-10-13")
        self.assertEqual((s["deadlines"]["today"],s["deadlines"]["tomorrow"]),(1,1))


class MineSummary(unittest.TestCase):
    """自分の持ち（mine）: 主担当か副担当になっている未完了のタスクだけを、同じ 1 回の読み取りから数える。"""
    ME = 1000000000000000002
    OTHER = 1000000000000000003
    def setUp(self):
        self.store = types.SimpleNamespace(list_tasks=Mock(return_value=[]))
        self.gateway = api.SqliteGateway(types.SimpleNamespace(DEPARTMENTS=DEPTS), self.store)
        self.context = types.SimpleNamespace(authorize=Mock(), scope=Mock(return_value="synthetic-scope"), actor_id=f"discord-{self.ME}")
    def held(self, number, assignee=None, helpers=(), deadline=None, status="todo"):
        return types.SimpleNamespace(task=types.SimpleNamespace(number=number, deadline=deadline, tags=("kikaku",), status=status, assignee_id=assignee, helpers=list(helpers)))
    def test_counts_open_tasks_I_lead_or_help_once_each(self):
        self.store.list_tasks.return_value = [
            self.held(1, self.ME, deadline="2026-10-13"),
            self.held(2, self.OTHER, [self.ME], "2026-10-14", "in_progress"),
            self.held(3, self.ME, deadline="2026-10-20", status="blocked"),
            self.held(4, self.ME, status="done"),
            self.held(5, self.OTHER),
            self.held(6),
        ]
        s = self.gateway.summary(self.context, NOW)
        self.assertEqual(s["mine"], {"remaining": 3, "lead": 2, "helper": 1, "overdue": 1, "today": 1})
        self.assertEqual(s["total"], 5)
        self.context.authorize.assert_called_once_with(None, "viewer")
        self.store.list_tasks.assert_called_once_with("synthetic-scope")
    def test_nothing_held_is_a_real_zero(self):
        self.store.list_tasks.return_value = [self.held(1, self.OTHER)]
        self.assertEqual(self.gateway.summary(self.context, NOW)["mine"], {"remaining": 0, "lead": 0, "helper": 0, "overdue": 0, "today": 0})
    def test_no_actor_leaves_mine_out(self):
        context = types.SimpleNamespace(authorize=Mock(), scope=Mock(return_value="synthetic-scope"))
        self.store.list_tasks.return_value = [self.held(1, self.ME)]
        self.assertNotIn("mine", self.gateway.summary(context, NOW))


class SummaryLivePermissions(unittest.TestCase):
    def test_one_authorization_uses_two_discord_reads_regardless_of_task_count(self):
        guild, actor, bot = ('1000000000000000001','1000000000000000002','1000000000000000003')
        calls=[]
        def get(path, _deadline, optional_member=False):
            calls.append(path)
            if path == '/guilds/'+guild:
                return {'id':guild,'owner_id':actor,'roles':[{'id':guild,'permissions':'0'}]}
            if path == '/guilds/'+guild+'/members/'+actor:
                return {'user':{'id':actor,'username':'Synthetic member'},'roles':[]}
            raise AssertionError('Summary must not load assignees or member lists')
        context=api.LiveContext(types.SimpleNamespace(get=get),types.SimpleNamespace(guild_ids={int(guild)}),api.uid(actor),bot,departments=DEPTS)
        domain=types.SimpleNamespace(DEPARTMENTS=DEPTS,Scope=lambda *_:'synthetic')
        store=types.SimpleNamespace(list_tasks=Mock(return_value=[task(n) for n in range(1000)]))
        result=api.SqliteGateway(domain,store).summary(context,NOW)
        self.assertEqual(result['total'],1000)
        self.assertEqual(len(calls),2)
        store.list_tasks.assert_called_once()

if __name__ == "__main__": unittest.main()
