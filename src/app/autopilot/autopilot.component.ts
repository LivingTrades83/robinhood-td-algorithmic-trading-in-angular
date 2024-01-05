import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { TimerObservable } from 'rxjs-compat/observable/TimerObservable';
import { finalize, takeUntil, take } from 'rxjs/operators';
import * as moment from 'moment-timezone';
import { AiPicksService, AuthenticationService, BacktestService, CartService, PortfolioInfoHolding, PortfolioService, ReportingService, ScoreKeeperService, TradeService } from '@shared/services';
import { SchedulerService } from '@shared/service/scheduler.service';
import { BacktestResponse } from '../rh-table';
import { SmartOrder } from '@shared/index';
import { divide, floor, round } from 'lodash';
import { DailyBacktestService } from '@shared/daily-backtest.service';
import { MessageService } from 'primeng/api';
import { AlgoQueueItem } from '@shared/services/trade.service';
import { ScoringIndex } from '@shared/services/score-keeper.service';
import { MachineDaytradingService } from '../machine-daytrading/machine-daytrading.service';
import { BearList, PrimaryList } from '../rh-table/backtest-stocks.constant';
import { AiPicksPredictionData } from '@shared/services/ai-picks.service';

export interface PositionHoldings {
  name: string;
  pl: number;
  netLiq: number;
  shares: number;
  alloc: number;
  recommendation: 'None' | 'Bullish' | 'Bearish';
  buyReasons: string;
  sellReasons: string;
  buyConfidence: number;
  sellConfidence: number;
  prediction: number;
}

export interface ProfitLossRecord {
  date: string;
  profit: number;
  lastStrategy: string;
  profitRecord: ScoringIndex<number>;
  lastRiskTolerance: number;
}

export enum DaytradingAlgorithms {
  recommendation,
  bband,
  demark9,
  macd,
  mfi,
  mfiTrade,
  roc,
  vwma
}

export enum SwingtradeAlgorithms {
  recommendation,
  demark9,
  macd,
  mfi,
  mfiDivergence,
  mfiDivergence2,
  mfiLow,
  mfiTrade,
  roc,
  vwma
}

export enum Strategy {
  DaytradeShort = 'DaytradeShort',
  Daytrade = 'Daytrade',
  Swingtrade = 'Swingtrade',
  InverseSwingtrade = 'InverseSwingtrade',
  Short = 'Short',
}

export enum RiskTolerance {
  Zero = 0.01,
  Lower = 0.02,
  Low = 0.05,
  ExtremeFear = 0.1,
  Fear = 0.25,
  Neutral = 0.5,
  Greed = 0.75,
  ExtremeGreed = 1,
  XLGreed = 1.05,
  XXLGreed = 1.1,
  XXXLGreed = 1.25,
  XXXXLGreed = 1.5,
  XXXXXLGreed = 1.75,
}

@Component({
  selector: 'app-autopilot',
  templateUrl: './autopilot.component.html',
  styleUrls: ['./autopilot.component.css']
})
export class AutopilotComponent implements OnInit, OnDestroy {
  display = false;
  isLoading = true;
  defaultInterval = 90000;
  interval = 90000;
  oneDayInterval;
  timer;
  alive = false;
  destroy$ = new Subject();
  currentHoldings = [];
  strategyCounter = null;
  maxTradeCount = 5;
  strategyList = [
    Strategy.Swingtrade,
    Strategy.Daytrade,
    // Strategy.InverseSwingtrade,
    Strategy.DaytradeShort,
    Strategy.Short
  ];

  riskCounter = 1;
  dayTradeRiskCounter = 0;

  riskToleranceList = [
    RiskTolerance.Fear,
    RiskTolerance.Neutral,
    RiskTolerance.Greed,
    RiskTolerance.ExtremeGreed
  ];

  dayTradingRiskToleranceList = [
    RiskTolerance.Low,
    RiskTolerance.ExtremeFear,
    RiskTolerance.Fear,
    RiskTolerance.Neutral,
    RiskTolerance.ExtremeGreed
  ];

  backtestBuffer$;

  isBacktested = false;

  isTradingStarted = false;
  simultaneousOrderLimit = 3;
  executedIndex = 0;
  lastOrderListIndex = 0;
  constructor(
    private authenticationService: AuthenticationService,
    private portfolioService: PortfolioService,
    private schedulerService: SchedulerService,
    private aiPicksService: AiPicksService,
    private backtestService: BacktestService,
    private cartService: CartService,
    private dailyBacktestService: DailyBacktestService,
    private messageService: MessageService,
    private scoreKeeperService: ScoreKeeperService,
    private reportingService: ReportingService,
    private tradeService: TradeService,
    private machineDaytradingService: MachineDaytradingService
  ) { }

  ngOnInit(): void {
    const lastStrategy = JSON.parse(localStorage.getItem('profitLoss'));
    if (lastStrategy && lastStrategy.lastStrategy) {
      const lastStrategyCount = this.strategyList.findIndex(strat => strat.toLowerCase() === lastStrategy.lastStrategy.toLowerCase());
      this.strategyCounter = lastStrategyCount >= 0 ? lastStrategyCount : 0;
      this.riskCounter = lastStrategy.lastRiskTolerance || 0;
    } else {
      this.strategyCounter = 0;
    }
  }

  open() {
    this.destroy$ = new Subject();
    if (this.backtestBuffer$) {
      this.backtestBuffer$.unsubscribe();
    }
    this.backtestBuffer$ = new Subject();

    this.display = true;
    this.startNewInterval();
    this.interval = Math.abs(moment(this.getStartStopTime().startDateTime).diff(moment(), 'milliseconds'));
    this.messageService.add({
      key: 'autopilot_start',
      severity: 'success',
      summary: 'Autopilot started'
    });
  }

  startNewInterval() {
    this.timer = TimerObservable.create(0, this.interval)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        const startStopTime = this.getStartStopTime();
        if (moment().isAfter(moment(startStopTime.endDateTime).subtract(5, 'minutes')) &&
          moment().isBefore(moment(startStopTime.endDateTime))) {
          if (this.reportingService.logs.length > 0) {
            const profitLog = `Profit ${this.scoreKeeperService.total}`;
            this.reportingService.addAuditLog(null, profitLog);
            this.reportingService.exportAuditHistory();
            this.setProfitLoss();
            this.scoreKeeperService.resetTotal();
            this.resetCart();
          }
        } else if (!this.isBacktested) {
          this.developStrategy();
          this.isBacktested = true;
        } else if (moment().isAfter(moment(startStopTime.startDateTime)) &&
          moment().isBefore(moment(startStopTime.endDateTime))) {
          if (this.isTradingStarted && this.hasOrders()) {
            this.executeOrderList();
            this.setProfitLoss();
          } else {
            setTimeout(() => {
              this.initializeOrders();
              this.isTradingStarted = true;
            }, this.defaultInterval);
          }
        } else if (!this.hasOrders && this.isBacktested) {
          this.isBacktested = false;
        }
      });
  }

  hasOrders() {
    return (this.cartService.sellOrders.length ||
      this.cartService.buyOrders.length || this.cartService.otherOrders.length);
  }

  resetBacktested() {
    setTimeout(() => {
      this.isBacktested = false;
    }, 18000000);
  }

  setProfitLoss() {
    const lastProfitLoss = JSON.parse(localStorage.getItem('profitLoss'));
    const tempProfitRecord = this.scoreKeeperService.profitLossHash;

    if (lastProfitLoss && lastProfitLoss.profitRecord) {
      for (const recordKey in lastProfitLoss.profitRecord) {
        if (lastProfitLoss.profitRecord[recordKey]) {
          if (tempProfitRecord[recordKey]) {
            tempProfitRecord[recordKey] += lastProfitLoss.profitRecord[recordKey];
          } else {
            tempProfitRecord[recordKey] = lastProfitLoss.profitRecord[recordKey];
          }
        }
      }
    }
    const profitObj: ProfitLossRecord = {
      'date': moment().format(),
      profit: this.scoreKeeperService.total,
      lastStrategy: this.strategyList[this.strategyCounter],
      lastRiskTolerance: this.riskCounter,
      profitRecord: tempProfitRecord
    };
    localStorage.setItem('profitLoss', JSON.stringify(profitObj));
  }

  stop() {
    this.display = false;
    this.timer.unsubscribe();
    this.cleanUp();
    this.messageService.add({
      key: 'autopilot_stop',
      severity: 'danger',
      summary: 'Autopilot stopped'
    });
  }

  resetCart() {
    this.executedIndex = 0;
    this.lastOrderListIndex = 0;
    this.resetBacktested();
    this.isTradingStarted = false;
    this.cartService.deleteCart();
  }

  decreaseRiskTolerance() {
    if (this.riskCounter > 0) {
      this.riskCounter--;
    }
    this.changeStrategy();
  }

  decreaseDayTradeRiskTolerance() {
    if (this.dayTradeRiskCounter > 0) {
      this.dayTradeRiskCounter = 0;
    }
    this.changeStrategy();
  }

  increaseRiskTolerance() {
    if (this.riskCounter < this.riskToleranceList.length) {
      this.riskCounter++;
    }
    console.log(`Increase risk to ${this.riskCounter}`);
  }

  increaseDayTradeRiskTolerance() {
    if (this.dayTradeRiskCounter < this.dayTradingRiskToleranceList.length) {
      this.dayTradeRiskCounter++;
    }
  }

  changeStrategy() {
    if (this.strategyCounter < this.strategyList.length - 1) {
      this.strategyCounter++;
    } else {
      this.strategyCounter = 0;
    }
    const strat = this.strategyList[this.strategyCounter];
    this.messageService.add({
      key: 'strategy_change',
      severity: 'info',
      summary: `Strategy changed to ${strat}`
    });
    console.log(`Strategy changed to ${strat}. Risk tolerance ${this.riskCounter}`);
  }

  async developStrategy() {
    const lastProfitLoss = JSON.parse(localStorage.getItem('profitLoss'));
    console.log('developing strategy lastProfitLoss', lastProfitLoss);
    if (lastProfitLoss && lastProfitLoss.profit) {
      if (lastProfitLoss.profit * 1 < 0) {
        if (lastProfitLoss.lastStrategy === Strategy.Daytrade) {
          this.increaseDayTradeRiskTolerance();
        } else {
          this.decreaseRiskTolerance();
        }

      } else if (lastProfitLoss.profit * 1 > 0) {
        if (lastProfitLoss.lastStrategy === Strategy.Daytrade) {
          this.decreaseDayTradeRiskTolerance();
        } else {
          this.increaseRiskTolerance();
        }
      }
    }
    this.processCurrentPositions();
  }

  async getNewTrades() {
    switch (this.strategyList[this.strategyCounter]) {
      case Strategy.Daytrade: {
        const callback = async (stock: PortfolioInfoHolding) => {
          const backtestDate = this.getLastTradeDate();
          try {
            const trainingResults = await this.machineDaytradingService.trainStock(stock.name, backtestDate.subtract({ days: 2 }).format('YYYY-MM-DD'), backtestDate.add({ days: 3 }).format('YYYY-MM-DD'));
            if (trainingResults[0].correct / trainingResults[0].guesses > 0.6 && trainingResults[0].guesses > 20) {
              const trainingMsg = `Day trade training results correct: ${trainingResults[0].correct}, guesses: ${trainingResults[0].guesses}`;
              this.reportingService.addAuditLog(stock.name, trainingMsg);
              await this.addDaytrade(stock.name);
            }
          } catch (error) {
            console.log('error getting training results ', error);
          }
        };

        this.findSwingtrades(callback);
        const lastProfitLoss = JSON.parse(localStorage.getItem('profitLoss'));
    
        if (lastProfitLoss && lastProfitLoss.profitRecord) {
          for (const recordKey in lastProfitLoss.profitRecord) {
            if (lastProfitLoss.profitRecord[recordKey] > 0) {
              await this.addDaytrade(recordKey);
            }
          }
        }
        break;
      }
      case Strategy.Swingtrade: {
        const callback = async (stock: PortfolioInfoHolding) => {
          await this.addBuy(stock);
          const log = `Adding swing trade ${stock.name}`;
          this.reportingService.addAuditLog(null, log);
        };

        this.findSwingtrades(callback);
        break;
      }
      case Strategy.InverseSwingtrade: {
        // TODO
        break;
      }
      case Strategy.Short: {
        this.findShort();
        break;
      }
      case Strategy.DaytradeShort: {
        await this.findDaytradeShort();
        break;
      }
      default: {
        break;
      }
    }
  }

  isBuyPrediction(prediction: { label: string, value: AiPicksPredictionData[] }) {
    if (prediction) {
      let predictionSum = 0;
      for (const p of prediction.value) {
        predictionSum += p.prediction;
      }

      if (predictionSum / prediction.value.length > 0.6) {
        return true;
      } else if (predictionSum / prediction.value.length < 0.3) {
        return false;
      }
    }
    return null;
  }

  findSwingtrades(cb = async (stock: PortfolioInfoHolding) => { }) {
    console.log('finding swing trade');
    this.machineDaytradingService.resetStockCounter();
    this.backtestBuffer$.unsubscribe();
    this.backtestBuffer$ = new Subject();
    const noOpportunityCounter = PrimaryList.length + 10;
    this.aiPicksService.mlNeutralResults.pipe(
      take(noOpportunityCounter),
      finalize(() => {
        this.setLoading(false);
      })
    ).subscribe(async (latestMlResult) => {
      console.log(`Received neutral results for ${latestMlResult.label} ${JSON.stringify(latestMlResult.value[0])}`);
      if (this.isBuyPrediction(latestMlResult)) {
        const stockHolding: PortfolioInfoHolding = {
          name: latestMlResult.label,
          pl: 0,
          netLiq: 0,
          shares: 0,
          alloc: 0,
          recommendation: 'None',
          buyReasons: '',
          sellReasons: '',
          buyConfidence: 0,
          sellConfidence: 0,
          prediction: null
        };
        console.log('Found:', stockHolding);
        sessionStorage.setItem('lastMlResult', JSON.stringify(latestMlResult));
        await cb(stockHolding);
      }
      this.schedulerService.schedule(() => {
        this.triggerBacktestNext();
      }, `findTrades`, null, false, 60000);
    }, error => {
      console.log(error);
      this.schedulerService.schedule(() => {
        this.triggerBacktestNext();
      }, `findTrades`, null, false, 60000);
    });
    this.setLoading(true);

    this.backtestBuffer$
      .pipe(takeUntil(this.destroy$),
        finalize(() => this.setLoading(false))
      )
      .subscribe(() => {
        const stock = this.machineDaytradingService.getNextStock();
        this.runAi(stock);
      });
    this.triggerBacktestNext();
  }

  async findDaytradeShort() {
    console.log('finding bearish day trade');
    this.machineDaytradingService.resetStockCounter();

    let idx = 0;
    while (idx < BearList.length) {
      idx++;
      const stock = BearList[idx].ticker;
      const backtestDate = this.getLastTradeDate();
      console.log('last date', backtestDate);
      const trainingResults = await this.machineDaytradingService.trainStock(stock, backtestDate.subtract({ days: 1 }).format('YYYY-MM-DD'), backtestDate.add({ days: 1 }).format('YYYY-MM-DD'));
      console.log('training daytrade results ', trainingResults);
      if (trainingResults[0].correct / trainingResults[0].guesses > 0.6 && trainingResults[0].guesses > 50) {
        await this.addDaytrade(stock);
        this.portfolioDaytrade(stock, this.dayTradingRiskToleranceList[this.dayTradeRiskCounter]);
        if (this.cartService.otherOrders.length > this.maxTradeCount) {
          break;
        }
      }
    }
    this.setLoading(false);
  }

  findShort() {
    let idx = -1;
    console.log('finding short');
    this.machineDaytradingService.resetStockCounter();
    this.backtestBuffer$.unsubscribe();
    this.backtestBuffer$ = new Subject();
    this.aiPicksService.mlNeutralResults.pipe(
      take(BearList.length),
      finalize(() => {
        this.setLoading(false);
      })
    ).subscribe(async (latestMlResult) => {
      console.log(`Received neutral results for ${latestMlResult.label} ${JSON.stringify(latestMlResult.value[0])}`);
      if (this.isBuyPrediction(latestMlResult)) {
        const stockHolding = {
          name: latestMlResult.label,
          pl: 0,
          netLiq: 0,
          shares: 0,
          alloc: 0,
          recommendation: 'None',
          buyReasons: '',
          sellReasons: '',
          buyConfidence: 0,
          sellConfidence: 0,
          prediction: null
        };
        console.log('Adding buy ', stockHolding);
        sessionStorage.setItem('lastMlResult', JSON.stringify(latestMlResult));
        await this.addBuy(stockHolding);
        const log = `Adding swing trade short ${stockHolding.name}`;
        this.reportingService.addAuditLog(stockHolding.name, log);
      }
      this.schedulerService.schedule(() => {
        this.triggerBacktestNext();
      }, `findTrades`, null, false, 60000);
    });
    this.setLoading(true);

    this.backtestBuffer$
      .pipe(takeUntil(this.destroy$),
        finalize(() => this.setLoading(false))
      )
      .subscribe(() => {
        const stock = BearList[idx++].ticker;
        console.log('run ai on ', stock);
        this.runAi(stock);
      });
    this.triggerBacktestNext();
  }

  triggerBacktestNext() {
    this.backtestBuffer$.next();
  }

  async addBuy(holding: PortfolioInfoHolding) {
    if (this.cartService.buyOrders.length < this.maxTradeCount) {
      const currentDate = moment().format('YYYY-MM-DD');
      const startDate = moment().subtract(100, 'days').format('YYYY-MM-DD');
      try {
        const indicators = await this.getTechnicalIndicators(holding.name, startDate, currentDate, this.currentHoldings).toPromise();
        const thresholds = this.getStopLoss(indicators.low, indicators.high);
        await this.portfolioBuy(holding,
          round(this.riskToleranceList[this.riskCounter], 2),
          thresholds.profitTakingThreshold,
          thresholds.stopLoss);
      } catch (error) {
        console.log('Error getting backtest data for ', holding.name, error);
        await this.portfolioBuy(holding,
          round(this.riskToleranceList[this.riskCounter], 2),
          null,
          null);
      }
    }
  }

  async addDaytrade(stock: string) {
    if (this.cartService.otherOrders.length < this.maxTradeCount) {
      const currentDate = moment().format('YYYY-MM-DD');
      const startDate = moment().subtract(100, 'days').format('YYYY-MM-DD');
      try {
        const indicators = await this.getTechnicalIndicators(stock, startDate, currentDate, this.currentHoldings).toPromise();
        const thresholds = this.getStopLoss(indicators.low, indicators.high);
        await this.portfolioDaytrade(stock,
          round(this.dayTradingRiskToleranceList[this.dayTradeRiskCounter], 2),
          thresholds.profitTakingThreshold,
          thresholds.stopLoss);
      } catch (error) {
        console.log('Error getting backtest data for daytrade', stock, error);
        await this.portfolioDaytrade(stock,
          round(this.dayTradingRiskToleranceList[this.dayTradeRiskCounter], 2),
          null,
          null);
      }
    }
  }

  initializeOrders() {
    const concat = this.cartService.sellOrders.concat(this.cartService.buyOrders);
    const orders = concat.concat(this.cartService.otherOrders);
    orders.forEach((order: SmartOrder) => {
      order.stopped = false;
      const queueItem: AlgoQueueItem = {
        symbol: order.holding.symbol,
        reset: true
      };

      this.tradeService.algoQueue.next(queueItem);
    });
  }

  executeOrderList() {
    const concat = this.cartService.sellOrders.concat(this.cartService.buyOrders);
    const orders = concat.concat(this.cartService.otherOrders);
    const limit = this.simultaneousOrderLimit > orders.length ? orders.length : this.simultaneousOrderLimit;

    while (this.executedIndex < limit && this.lastOrderListIndex < orders.length) {
      const queueItem: AlgoQueueItem = {
        symbol: orders[this.lastOrderListIndex].holding.symbol,
        reset: false
      };

      setTimeout(() => {
        this.tradeService.algoQueue.next(queueItem);
      }, 500 * this.lastOrderListIndex);
      this.lastOrderListIndex++;
      this.executedIndex++;
    }
    if (this.lastOrderListIndex >= orders.length) {
      this.lastOrderListIndex = 0;
    }
    if (this.executedIndex >= limit) {
      setTimeout(() => {
        this.executedIndex = 0;
      }, 500);
    }
  }

  getStartStopTime() {
    const endTime = '16:00';
    const currentMoment = moment().tz('America/New_York').set({ hour: 9, minute: 50 });
    const currentEndMoment = moment().tz('America/New_York').set({ hour: 16, minute: 0 });
    const currentDay = currentMoment.day();
    let startDate;

    if (currentDay === 6) {
      startDate = currentMoment.add({ day: 2 });
    } else if (currentDay === 0) {
      startDate = currentMoment.add({ day: 1 });
    } else {
      if (moment().isAfter(currentMoment) && moment().isBefore(currentEndMoment)) {
        startDate = currentMoment;
      } else {
        startDate = moment().tz('America/New_York').set({ hour: 9, minute: 50 }).add(1, 'days');
      }
    }

    const startDateTime = moment.tz(startDate.format(), 'America/New_York').toDate();
    const endDateTime = moment.tz(`${startDate.format('YYYY-MM-DD')} ${endTime}`, 'America/New_York').toDate();
    return {
      startDateTime,
      endDateTime
    };
  }

  getLastTradeDate() {
    const currentMoment = moment().tz('America/New_York').set({ hour: 9, minute: 50 });
    const currentDay = currentMoment.day();
    let lastTradeDate = currentMoment.subtract({ day: 1 });

    if (currentDay === 6) {
      lastTradeDate = currentMoment.subtract({ day: 1 });
    } else if (currentDay === 7) {
      lastTradeDate = currentMoment.subtract({ day: 2 });
    } else if (currentDay === 0) {
      lastTradeDate = currentMoment.subtract({ day: 2 });
    } else if (currentDay === 1) {
      lastTradeDate = currentMoment.subtract({ day: 3 });
    } else if (currentDay === 2) {
      lastTradeDate = currentMoment.add({ day: 1 });
    }

    return moment.tz(lastTradeDate.format(), 'America/New_York');
  }

  setLoading(value: boolean) {
    this.isLoading = value;
  }

  async processCurrentPositions() {
    await this.authenticationService.checkCredentials(this.authenticationService?.selectedTdaAccount?.accountId).toPromise();
    this.currentHoldings = [];
    const currentDate = moment().format('YYYY-MM-DD');
    const startDate = moment().subtract(365, 'days').format('YYYY-MM-DD');
    this.setLoading(true);
    const balance: any = await this.portfolioService.getTdBalance().toPromise();
    const totalValue = balance.cashBalance;

    if (totalValue > 0) {
      const data = await this.portfolioService.getTdPortfolio()
        .pipe(
          finalize(() => this.setLoading(false))
        ).toPromise();

      if (data) {
        this.aiPicksService.mlNeutralResults.pipe(
          take(data.length)
        ).subscribe(async (latestMlResult) => {
          console.log('Received results for current holdings', latestMlResult);
          const stockSymbol = latestMlResult.label;
          const order = this.cartService.buildOrder(stockSymbol);
          const found = this.currentHoldings.find((value) => {
            return value.name === stockSymbol;
          });

          const isBuy = this.isBuyPrediction(latestMlResult);
          if (isBuy === true) {
            this.cartService.deleteSell(order);
            if (found) {
              await this.addBuy(found);
            }
          } else if (isBuy === false) {
            this.cartService.deleteBuy(order);
          }
        });

        for (const holding of data) {
          const stock = holding.instrument.symbol;
          let pl;
          if (holding.instrument.assetType.toLowerCase() === 'option') {
            pl = holding.marketValue - (holding.averagePrice * holding.longQuantity) * 100;
          } else {
            pl = holding.marketValue - (holding.averagePrice * holding.longQuantity);
          }
          this.currentHoldings.push({
            name: stock,
            pl,
            netLiq: holding.marketValue,
            shares: holding.longQuantity,
            alloc: (holding.averagePrice * holding.longQuantity) / totalValue,
            recommendation: 'None',
            buyReasons: '',
            sellReasons: '',
            buyConfidence: 0,
            sellConfidence: 0,
            prediction: null
          });

          if (holding.instrument.assetType.toLowerCase() === 'equity') {
            const indicators = await this.getTechnicalIndicators(holding.instrument.symbol, startDate, currentDate, this.currentHoldings).toPromise();
            const foundIdx = this.currentHoldings.findIndex((value) => {
              return value.name === stock;
            });
            this.currentHoldings[foundIdx].recommendation = indicators.recommendation.recommendation;
            const reasons = this.getRecommendationReason(indicators.recommendation);
            this.currentHoldings[foundIdx].buyReasons = reasons.buyReasons;
            this.currentHoldings[foundIdx].sellReasons = reasons.sellReasons;
            if (reasons.buyReasons.length > reasons.sellReasons.length) {
              this.aiPicksService.tickerBuyRecommendationQueue.next(stock);
            } else {
              this.aiPicksService.tickerSellRecommendationQueue.next(stock);
            }
          }
        }
        this.checkIfTooManyHoldings(this.currentHoldings);
        this.checkForStopLoss(this.currentHoldings);
        this.getNewTrades();
      }
    }
  }

  getTechnicalIndicators(stock: string, startDate: string, currentDate: string, holdings) {
    return this.backtestService.getBacktestEvaluation(stock, startDate, currentDate, 'daily-indicators')
      .map((indicatorResults: BacktestResponse) => {
        this.getIndicatorScore(stock, indicatorResults.signals, holdings);
        return indicatorResults.signals[indicatorResults.signals.length - 1];
      });
  }

  getIndicatorScore(stock, signals, holdings) {
    this.dailyBacktestService.getSignalScores(signals).subscribe((score) => {
      const foundIdx = holdings.findIndex((value) => {
        return value.name === stock;
      });

      if (!holdings[foundIdx]) {
        return;
      }

      if (holdings[foundIdx].buyReasons) {
        const indicators = holdings[foundIdx].buyReasons.split(',');

        for (const i in indicators) {
          if (indicators.hasOwnProperty(i)) {
            holdings[foundIdx].buyConfidence += score[indicators[i]].bullishMidTermProfitLoss;
            this.analyseRecommendations(holdings[foundIdx]);
          }
        }
      }
      if (holdings[foundIdx].sellReasons) {
        const indicators = holdings[foundIdx].sellReasons.split(',');
        for (const i in indicators) {
          if (indicators.hasOwnProperty(i)) {
            holdings[foundIdx].sellConfidence += score[indicators[i]].bearishMidTermProfitLoss;
            this.analyseRecommendations(holdings[foundIdx]);
          }
        }
      }
    });
  }

  async analyseRecommendations(holding: PortfolioInfoHolding) {
    if (holding.recommendation.toLowerCase() === 'buy') {
      if (holding.buyConfidence >= 0) {
        console.log('Buying ', holding.name);
        await this.addBuy(holding);
      }
    } else if (holding.recommendation.toLowerCase() === 'sell') {
      if (holding.sellConfidence >= 0) {
        this.portfolioSell(holding);
      }
    }
  }

  async checkForStopLoss(holdings: PositionHoldings[]) {
    holdings.forEach(async (val) => {
      const percentLoss = divide(val.pl, val.netLiq);
      if (percentLoss < -0.05) {
        this.portfolioSell(val);
      } else if (percentLoss > 0) {
        await this.addBuy(val);
      }
    });
  }

  checkIfTooManyHoldings(currentHoldings: any[]) {
    if (currentHoldings.length > this.maxTradeCount) {
      currentHoldings.sort((a, b) => a.pl - b.pl);
      const toBeSold = currentHoldings.slice(0, 1);
      console.log('too many holdings. selling', toBeSold, 'from', currentHoldings);
      toBeSold.forEach(holdingInfo => {
        console.log('selling ', holdingInfo);
        this.portfolioSell(holdingInfo);
      });
    }
  }

  buildOrder(symbol: string, quantity = 0, price = 0,
    side = 'DayTrade', orderSizePct = 0.5, lossThreshold = -0.004,
    profitTarget = 0.008, trailingStop = -0.003, allocation = null): SmartOrder {
    return {
      holding: {
        instrument: null,
        symbol,
      },
      quantity,
      price,
      submitted: false,
      pending: false,
      orderSize: floor(quantity * orderSizePct) || 1,
      side,
      lossThreshold: lossThreshold,
      profitTarget: profitTarget,
      trailingStop: trailingStop,
      useStopLoss: true,
      useTrailingStopLoss: true,
      useTakeProfit: true,
      // sellAtClose: side.toUpperCase() === 'DAYTRADE' ? true : false,
      sellAtClose: false,
      allocation
    };
  }

  getAllocationPct(totalAllocationPct: number = 0.1, numberOfOrders: number) {
    return round(divide(totalAllocationPct, numberOfOrders), 2);
  }

  async portfolioSell(holding: PortfolioInfoHolding) {
    const price = await this.portfolioService.getPrice(holding.name).toPromise();
    const orderSizePct = 0.5;
    const order = this.buildOrder(holding.name, holding.shares, price, 'Sell',
      orderSizePct, null, null, null);
    this.cartService.addToCart(order);
  }

  async portfolioBuy(holding: PortfolioInfoHolding,
    allocation: number,
    profitThreshold: number = null,
    stopLossThreshold: number = null) {
    const price = await this.portfolioService.getPrice(holding.name).toPromise();
    const data = await this.portfolioService.getTdBalance().toPromise();
    const quantity = this.getQuantity(price, allocation, data.cashBalance);
    const orderSizePct = (this.riskToleranceList[this.riskCounter] > 0.5) ? 0.5 : 0.3;
    const order = this.buildOrder(holding.name, quantity, price, 'Buy',
      orderSizePct, stopLossThreshold, profitThreshold,
      stopLossThreshold);
    this.cartService.addToCart(order);
  }

  async portfolioDaytrade(symbol: string,
    allocation: number,
    profitThreshold: number = null,
    stopLossThreshold: number = null) {
    const price = await this.portfolioService.getPrice(symbol).toPromise();
    const data = await this.portfolioService.getTdBalance().toPromise();
    const quantity = this.getQuantity(price, allocation, data.cashBalance);
    const orderSizePct = 0.5;
    const order = this.buildOrder(symbol,
      quantity,
      price,
      'DayTrade',
      orderSizePct,
      stopLossThreshold,
      profitThreshold,
      stopLossThreshold,
      allocation);
    console.log('add day trade: ', order);
    this.cartService.addToCart(order);
  }

  private getQuantity(stockPrice: number, allocationPct: number, total: number) {
    const totalCost = round(total * allocationPct, 2);
    return Math.ceil(totalCost / stockPrice);
  }

  getRecommendationReason(recommendation) {
    const reasons = {
      buyReasons: '',
      sellReasons: ''
    };

    const buyReasons = [];
    const sellReasons = [];

    for (const rec in recommendation) {
      if (recommendation.hasOwnProperty(rec)) {
        if (recommendation[rec].toLowerCase() === 'bullish') {
          buyReasons.push(rec);
        } else if (recommendation[rec].toLowerCase() === 'bearish') {
          sellReasons.push(rec);
        }
      }
    }

    reasons.buyReasons += buyReasons.join(',');
    reasons.sellReasons += sellReasons.join(',');

    return reasons;
  }

  runAi(stockName: string) {
    this.schedulerService.schedule(() => {
      this.aiPicksService.tickerSellRecommendationQueue.next(stockName);
      this.aiPicksService.tickerBuyRecommendationQueue.next(stockName);
    }, 'portfolio_mgmt_ai');
  }

  private getStopLoss(low: number, high: number) {
    const profitTakingThreshold = round(((high / low) - 1) / 2, 4);
    const stopLoss = (round(profitTakingThreshold / 2, 4)) * -1;
    return {
      profitTakingThreshold,
      stopLoss
    }
  }

  cleanUp() {
    this.resetCart();
    this.destroy$.next();
    this.destroy$.complete();
    this.backtestBuffer$.unsubscribe();
  }

  ngOnDestroy() {
    this.cleanUp();
  }
}
