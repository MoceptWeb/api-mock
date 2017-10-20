/**
 * client
 */

const buildExampleFromSchema = require('mocker-dsl-core/lib/buildExampleFromSchema')
const pathToRegexp = require('path-to-regexp')
const util = require('../util')

const sleep = ms => cb => setTimeout(cb, ms)

const BASE_TYPES = [ 'string', 'number', 'boolean', 'object', 'array' ]
module.exports = app => {
  class ClientController extends app.Controller {
    * findApi (method) {
      const id = this.ctx.params[0]
      if (id.length < 5) {
        // hack方法，兼容老的存下url信息的api
        const url = `/client/${id}`
        return yield app.model.api.findOne({ url, 'options.method': method }).exec()
      }
      return yield app.model.api.findOne({ _id: id, 'options.method': method }).exec()
    }
    * real () {
      const { _apiRealUrl, _apiMethod } = this.ctx.request.body
      if (!_apiRealUrl || !_apiMethod) {
        this.ctx.body = {
          success: false,
          message: '真实地址为空'
        }
      }
      // 删除这两个参数，代理其他参数
      delete this.ctx.request.body._apiRealUrl
      delete this.ctx.request.body._apiMethod
      yield this.proxy(_apiRealUrl, _apiMethod)
    }
    * mock () {
      const { groupId } = this.ctx.params
      const group = yield this.service.group.getById(groupId)
      const method = this.ctx.method.toLowerCase()
      const query = this.ctx.request.query
      let body = this.ctx.request.body

      // 支持目前h5项目的PHP接口
      if (query._mockPostFix) {
        try {
          body = JSON.parse(Object.keys(body)[0])
        } catch (e) {}
      }

      // 根据URL获取记录
      let record = yield this.service.api.findByCond({ group: group._id, 'options.method': method })
      const reqUrl = this.getReqUrl()

      record = record.filter((r) => {
         // variable
        let urlCheckResult = true
        let queryCheckResult = true
        let bodyCheckResult = true

        // path校验
        urlCheckResult = this.checkPath(r.options.params.path, r.reqUrl, reqUrl)
        if (!urlCheckResult) {
          return false
        }

        // query校验
        queryCheckResult = this.checkRequest(r.options.params.query, query)
        if (!queryCheckResult) {
          return false
        }

        // 如果是get请求，不需要对比body
        if (method !== 'get') {
          bodyCheckResult = this.checkRequest(r.options.params.body, body)
        }

        return urlCheckResult && queryCheckResult && bodyCheckResult
      })

      // 如果没有找到记录
      if (record.length === 0) {
        this.fail('没有找到记录')
        return
      }

      // 如果找到多条记录
      if (record.length > 1) {
        this.fail('找到多条记录')
        return
      }

      yield this.handleRequest(record[0], { body })
    }
    checkPath (paramsPath, paramsReqUrl, reqUrl) {
      if (!Array.isArray(paramsPath)) {
        return true
      }

      let pathStr = paramsPath.reduce((arr, p) => {
        if (p.key) {
          arr.push(`:${p.key}${!p.required ? '?' : ''}`)
        }

        return arr
      }, []).join('/')

      if (pathStr) {
        pathStr = `/${pathStr}`
      }

      return pathToRegexp(`${paramsReqUrl}${pathStr}`).test(reqUrl)
    }
    checkRequest (paramsArr, paramsObj) {
      // 如果非数组，返回true
      if (!Array.isArray(paramsArr)) {
        return true
      }

      // key必须有值
      paramsArr = paramsArr.filter(q => !!q.key)

      return paramsArr.every((q) => {
        // 如果固定值，值不相等，校验失败
        if (q.fixed && util.convertDataType(q.type, paramsObj[q.key]) !== q.example) {
          return false
        }

        // 如果必填，值不存在，校验失败
        if (q.required && !util.hasOwnProp(paramsObj, q.key)) {
          return false
        }

        return true
      })
    }
    * proxy (url, method) {
      const query = this.ctx.request.url.split('?')[1]
      if (query) {
        url += `?${query}`
      }
      const headers = this.ctx.headers
      delete headers.host // 提交的header.host是mocker的host，需要删除
      if (headers['api-cookie']) { // 如果请求头带有此字段，则设置cookie
        headers.cookie = headers['api-cookie']
        delete headers['api-cookie']
      }
      const opts = method === 'get' ? {} : { // body数据，暂时只支持json格式，未来可以从header中判断
        data: this.ctx.request.body,
        headers,
        dataType: 'json'
      }
      opts.method = method
      const result = yield this.ctx.curl(url, opts)
      this.ctx.status = result.status
      delete result.headers['content-encoding'] // 设置了gzip encoding的话，转发请求将会出错，先取消此请求头的返回
      this.ctx.set(result.headers)
      this.ctx.body = result.data
    }
    * handleProxy (api) { // 如果url中带有_mockProxyStatus此参数，则开启代理转发
      const { _mockProxyStatus } = this.ctx.request.query
      if (api.options.proxy.mode === 1 || _mockProxyStatus === '1') { // 代理转发线上
        yield this.proxy(api.prodUrl, api.options.method)
        return true
      }
      if (api.options.proxy.mode === 2 || _mockProxyStatus === '2') { // 代理转发测试
        yield this.proxy(api.devUrl, api.options.method)
        return true
      }
      return false
    }
    * handleRequest (api, data) {
      if (!api) {
        return
      }
      if (yield this.handleProxy(api)) {
        return
      }
      const delay = api.options.delay || 0
      yield sleep(delay)
      this.validateParams(api, data)
      this.ctx.body = this.getResponse(api) || {}
    }
    getResponse (api) {
      if (api.options.response && api.options.response.length > 0) {
        const index = api.options.responseIndex
        const idx = index === -1 ? parseInt(Math.random() * api.options.response.length) : index
        const schema = api.options.response[idx]
        return buildExampleFromSchema(schema)
      } else {
        return {}
      }
    }
    // get/:id
    * show () {
      const document = yield this.findApi('get')
      yield this.handleRequest(document)
    }
    // post /
    * create () {
      const document = yield this.findApi('post')
      yield this.handleRequest(document)
    }
    // put
    * put () {
      const document = yield this.findApi('put')
      yield this.handleRequest(document)
    }
    // patch
    * patch () {
      const document = yield this.findApi('patch')
      yield this.handleRequest(document)
    }
    // delete
    * delete () {
      const document = yield this.findApi('delete')
      yield this.handleRequest(document)
    }
    getReqUrl () {
      const pathArr = this.ctx.path.replace(/(^\/|\/$)/, '').split('/')
      return `/${pathArr.slice(2).join('/')}`
    }
    getPathParams (api) { // 获取RESTful风格Url参数
      const pathParams = {}
      const params = (this.ctx.params[1] || '').split('/')
      api.options.params.path.forEach((p, index) => {
        pathParams[p.key] = params[index]
      })
      return pathParams
    }
    getValidatorType (method, paramType) {
      // 若参数是以query 或者 restful 或者 x-www-form-urlencoded 方式提交的，则允许字符串格式的数字与布尔值
      const isUnstrict = method === 'query' || method === 'path' || this.ctx.header['content-type'].indexOf('x-www-form-urlencoded')
      if (isUnstrict && ['number', 'boolean'].indexOf(paramType) > -1) {
        return `unstrict_${paramType}`
      }
      return paramType
    }
    validateParams (api, customData) {
      const data = Object.assign({
        query: this.ctx.request.query,
        body: this.ctx.request.body,
        path: this.getPathParams(api)
      }, customData)
      const { params, method } = api.options
      for (const name in params) {
        const rule = {}
        // get请求不校验body
        if (method === 'get' && name === 'body') continue
        params[name].forEach(param => {
          // 参数不存在或者参数类型不属于基本类型时，不校验
          if (!param.key || BASE_TYPES.indexOf(param.type) === -1) return
          rule[param.key] = {
            type: this.getValidatorType(name, param.type),
            required: param.required,
            allowEmpty: param.type === 'string'
          }
        })
        this.ctx.validate(rule, data[name])
      }
    }
  }

  // 数字校验-允许提交字符串格式的数字
  app.validator.addRule('unstrict_number', (rule, value) => {
    if (value && !isNaN(value)) {
      value = Number(value)
    }
    if (typeof value !== 'number') {
      return 'should be a number'
    }
  })
  app.validator.addRule('unstrict_boolean', (rule, value) => {
    if (typeof value === 'boolean') return
    if (value === 'false' || value === 'true') return
    return 'should be a boolean'
  })

  return ClientController
}
