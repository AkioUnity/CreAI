const tf = require('@tensorflow/tfjs-node');
const db = require('./js/database');
const stockapi = require('./js/stockapi')
const currencySymbol = require('currency-symbol-map')
const Chart = require('chart.js')
const electron = require('electron');
const remote = electron.remote;

function minMaxScaler(val, min, max) {
    return (val - min) / (max - min);
}

function minMaxInverseScaler(val, min, max) {
    return val * (max - min) + min;
}

function getStocks() {
    $stocks = $('#stocksList');
    let conn = db.conn;

    conn.each('SELECT ID,"Index",StockName FROM Stocks', (err, row) => {
        if (err) {
            console.log(err);
        } else {
            $stocks.append(`
                <option value="`+ row['Index'] + `">` + row.StockName + ` - ` + row.Index + `</option>
            `);
        }
    });
}

function updatePredictChart() {

    $stock = $('#stocksList').val();
    let conn = db.conn;
    conn.get('SELECT * FROM Stocks WHERE "Index"=?', $stock, (err, row) => {
        predictChart.options.title.text = row.StockName;
        predictChart.options.scales.yAxes[0].scaleLabel.labelString = `Stock Price (${currencySymbol(row.Currency)})`;
        predictChart.update();
        $('#currencySymbol').html(currencySymbol(row.Currency));

    });
    openSnackbar("Fetching Stock data");

    stockapi.getStockHistoricalDaily($stock, (data) => {

        prices = data[0];
        let min = Math.min.apply(null, prices);
        let max = Math.max.apply(null, prices);
        prices = prices.map((el) => minMaxScaler(el, min, max));
        dates = data[1];
        var lookbackPrices = [];
        var targets = [];
        for (let index = 10; index < prices.length; index++) {
            lookbackPrices[index - 10] = prices.slice(index - 10, index);
            targets.push(prices[index]);
        }
        tfPrices = tf.tensor2d(lookbackPrices);
        global.pred = tf.tensor2d(lookbackPrices[0], [1, 10]);
        global.pred = tf.reshape(global.pred, [1, 10, 1]);
        tfTargets = tf.tensor1d(targets);
        tfPrices = tf.reshape(tfPrices, [prices.length - 10, 10, 1]);
        //tfPrices.print();
        //tfTargets.print();


        const model = tf.sequential();
        model.add(tf.layers.lstm({ units: 32, inputShape: [10, 1] }));
        model.add(tf.layers.dense({ units: 1, activation: 'linear' }));
        $lr = parseFloat($('#txtLearningRate').val());
        const lr = $lr;
        const opt = tf.train.adam(lr);
        const loss = 'meanSquaredError';
        openSnackbar("Compiling model");
        model.compile({ optimizer: opt, loss: loss, metrics: ['mae', 'mse'] }); /* Using Mean Absolute Error as metrics for accuracy of model */

        async function fit() {
            t = targets.map((el) => minMaxInverseScaler(el, min, max));
            t = t.slice(t.length - 100, t.length);
            predictChart.data.labels = dates.slice(dates.length - 100, dates.length);

            var loss = Infinity;
            var epochs = 1;
            var targetEpochs = parseFloat($('#txtNumEpochs').val());
            while (epochs < targetEpochs && window.startStop == 1) {
                const resp = await model.fit(tfPrices, tfTargets, {
                    epochs: 1,
                    callbacks: {
                        onEpochEnd: (epoch, log) => {
                            epochs += 1;
                            loss = log.loss;
                            tf.tidy(()=>{
                                
                                pred = model.predict(tfPrices);
                                pred.data().then(d => {
                                    ds = d.map((el) => minMaxInverseScaler(el, min, max));
                                    ds = ds.slice(d.length - 100, d.length);
                                    
                                    predictChart.data.datasets[0].data = t;
                                    predictChart.data.datasets[1].data = ds;
                                    
                                    predictChart.update();
    
                                    openSnackbar(`Training model - Epoch ${epochs}: loss = ${log.loss} `);
                                });
                            });
                        }
                    },
                    shuffle: true
                });
            }


        }
        function predictNextStep(tfData) {
            const tfPred = model.predict(tfData);
            return tfPred.dataSync()[0];
        }
        fit().then(() => {
            window.startStop = 0;
            btn.removeClass('stopTraining');
            btn.addClass('startTraining');
            $('#startStopTraining').html("Start Training");


            stockapi.getDataForPrediction($stock, (data) => {
                var prices = data[0];
                prices = prices.slice(0, prices.length);
                var lastPrice = prices[prices.length - 1];
                var dates = data[1];
                var testdata = prices.map((el) => minMaxScaler(el, min, max));
                const tfTest = tf.tensor3d(testdata, [1, prices.length, 1]);
                const tfPred = model.predict(tfTest);
                var predVal = tfPred.dataSync()[0];
                var finalPredictions = [];
                console.log("Predicting finally!");
                for (let numPred = 0; numPred < 5; numPred++) {
                    testdata.shift();
                    testdata.push(predVal);
                    predVal = predictNextStep(tf.tensor3d(testdata, [1, prices.length, 1]));
                    finalPredictions.push(predVal);
                }

                finalPredictions = finalPredictions.map((el) => minMaxInverseScaler(el, min, max))
                console.log("Final Prediction: ");
                console.log("Final predictions", finalPredictions);

                let sum = finalPredictions.reduce((previous, current) => current += previous);
                var forecastPrice = sum / finalPredictions.length;

                $('.forecast').css('display', 'block');
                openSnackbar("Training Complete - Forecasted Price: " + Math.round(forecastPrice, 2));
                console.log(forecastPrice, lastPrice);
                if (forecastPrice > lastPrice) {
                    alert("Forcasted Bullish trajectory - Target Price: " + forecastPrice);
                    $('#forecast-price').html(`${Math.round(forecastPrice, 2)} (Bullish)`);
                } else {
                    alert("Forcasted Bearish trajectory - Target Price: " + forecastPrice);
                    $('#forecast-price').html(`${Math.round(forecastPrice, 2)} (Bearish)`);

                }

            });
        });
    });
}



var ctx = $('#predictChart')
var predictChart = new Chart(ctx, {
    type: 'line',
    data: {
        datasets: [{
            type: 'line',
            label: 'Actual',
            fill: false,
            data: [],
            borderColor: '#DC143C',
            backgroundColor: '#DC143C',
            pointRadius: 1
        }, {
            type: 'line',
            label: 'Predicted',
            fill: false,
            data: [],
            borderColor: '#006400',
            backgroundColor: '#006400',
            pointRadius: 1
        }]
    },
    options: {
        responsive: true,
        title: {
            display: true,
            //text: 'Select a Stock and Indicator to view characterstics'
        },
        scales: {
            xAxes: [{
                display: true,
                gridLines: {
                    display: false
                },
                distribution: 'series',
                type: 'time',
                scaleLabel: {
                    display: true,
                    labelString: "Time"
                }
            }],
            yAxes: [{
                type: 'linear',
                gridLines: {
                    display: false
                },
                scaleLabel: {
                    display: true,
                    labelString: "Stock Price"
                }
            }]
        }
    }
});

const sb = mdc.snackbar.MDCSnackbar.attachTo(document.querySelector('.mdc-snackbar'));
function openSnackbar(snackbarMsg) {
    $snackbar = $("#snackbar-msg");
    $snackbar.text(snackbarMsg);
    sb.open();
}


$(document).ready(function () {
    getStocks();
    window.startStop = 0;
    $('#startStopTraining').on('click', () => {
        btn = $('#startStopTraining');
        if (window.startStop == 0 && $('#stocksList').val() != null) {
            btn.removeClass('startTraining');
            btn.addClass('stopTraining');
            btn.html('Stop Training');
            window.startStop = 1;
            updatePredictChart();
        }
        else if (window.startStop == 1) {
            window.startStop = 0;
            btn.removeClass('stopTraining');
            btn.addClass('startTraining');
            $('#startStopTraining').html("Start Training");
            openSnackbar("Training Stopped");

        }
        else {
            openSnackbar("Please check all fields!");
        }
        console.log(window.startStop);
    })
});


const select = document.querySelectorAll('.mdc-select');
for (const s of select) {
    mdc.select.MDCSelect.attachTo(s);
}

const textfields = document.querySelectorAll('.mdc-text-field');
for (const tf of textfields) {
    mdc.textField.MDCTextField.attachTo(tf);
}

const buttons = document.querySelectorAll('button');
for (const button of buttons) {
    mdc.ripple.MDCRipple.attachTo(button);
}
