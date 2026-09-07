# Distribute an explicitly selected formal iOS build to the existing Testers group.
# Apple API reference: https://developer.apple.com/documentation/appstoreconnectapi/beta-app-review-submissions
require 'base64'
require 'json'
require 'net/http'
require 'openssl'
require 'uri'
$stdout.sync = true

def b64(value)
  Base64.urlsafe_encode64(value, padding: false)
end

def api(method, path, payload = nil, query = {})
  now = Time.now.to_i
  header = b64(JSON.generate(alg: 'ES256', kid: ENV.fetch('APP_STORE_CONNECT_KEY_ID'), typ: 'JWT'))
  claims = b64(JSON.generate(iss: ENV.fetch('APP_STORE_CONNECT_ISSUER_ID'), iat: now, exp: now + 600, aud: 'appstoreconnect-v1'))
  message = "#{header}.#{claims}"
  key = OpenSSL::PKey.read(Base64.decode64(ENV.fetch('APP_STORE_CONNECT_API_KEY')))
  der = key.dsa_sign_asn1(OpenSSL::Digest::SHA256.digest(message))
  signature = OpenSSL::ASN1.decode(der).value.map { |n| [n.value.to_i.to_s(16).rjust(64, '0')].pack('H*') }.join
  uri = URI("https://api.appstoreconnect.apple.com#{path}")
  uri.query = URI.encode_www_form(query) unless query.empty?
  request = Net::HTTP.const_get(method.capitalize).new(uri)
  request['Authorization'] = "Bearer #{message}.#{b64(signature)}"
  request['Content-Type'] = 'application/json'
  request.body = JSON.generate(payload) if payload
  response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 30, read_timeout: 60) { |http| http.request(request) }
  raise "ASC #{method} #{path}: #{response.code} #{response.body}" unless response.is_a?(Net::HTTPSuccess)
  response.body.to_s.empty? ? {} : JSON.parse(response.body)
end

class TestFlightRelease
  APP = '6807904930'
  def initialize(client, version, number, apply: false)
    raise 'Expected a stable marketing version' unless version.match?(/\A\d+\.\d+\.\d+\z/)
    raise 'Invalid numeric build number' unless number.match?(/\A\d+(?:\.\d+){0,2}\z/)
    @client, @version, @number, @apply = client, version, number, apply
  end

  def call(method, path, payload = nil, query = {})
    @client.call(method, path, payload, query)
  end

  def run
    builds = call('get', '/v1/builds', nil, 'filter[app]' => APP, 'filter[version]' => @number)['data']
    raise 'Expected one uploaded build' unless builds.length == 1
    build = builds.first
    id = build.fetch('id')
    raise 'Build is not processed and valid' unless build['attributes']['processingState'] == 'VALID'
    raise 'Build is expired' if build['attributes']['expired']
    release = call('get', "/v1/builds/#{id}/preReleaseVersion")['data']
    raise 'Marketing version does not match release tag' unless release['attributes']['version'] == @version
    raise 'Expected an iOS build' unless release['attributes']['platform'] == 'IOS'

    groups = call('get', '/v1/betaGroups', nil, 'filter[app]' => APP)['data']
    matches = groups.select { |g| g['attributes']['name'] == 'Testers' && g['attributes']['isInternalGroup'] == false }
    raise 'Existing external Testers group not found uniquely' unless matches.length == 1
    group = matches.first

    # The same standard cryptography and no-France classification used by the
    # previously distributed build. Never infer an exemption from missing data.
    previous = call('get', '/v1/builds', nil, 'filter[app]' => APP, 'filter[version]' => '0.6.4')['data'].first
    raise 'Encryption baseline build missing' unless previous
    declaration = call('get', "/v1/builds/#{previous['id']}/appEncryptionDeclaration")['data']
    encryption = if declaration
      a = declaration['attributes']
      raise 'Baseline is not standard-crypto/no-France' unless a['containsThirdPartyCryptography'] == true && a['containsProprietaryCryptography'] == false && a['availableOnFrenchStore'] == false
      {relationships: {appEncryptionDeclaration: {data: {type: 'appEncryptionDeclarations', id: declaration['id']}}}}
    elsif previous['attributes']['usesNonExemptEncryption'] == false
      {attributes: {usesNonExemptEncryption: false}}
    else
      raise 'Explicit encryption classification missing'
    end

    detail = call('get', "/v1/builds/#{id}/buildBetaDetail")['data']
    state = detail['attributes']['externalBuildState']
    accepted_states = %w[MISSING_EXPORT_COMPLIANCE READY_FOR_BETA_SUBMISSION WAITING_FOR_BETA_REVIEW IN_BETA_REVIEW BETA_APPROVED READY_FOR_BETA_TESTING IN_BETA_TESTING]
    raise "Build needs manual attention: #{state}" unless accepted_states.include?(state)
    report = {version: @version, build: @number, buildId: id, externalBuildState: state, group: 'Testers', apply: @apply, encryptionBaseline: previous['attributes']['version']}
    return report unless @apply

    call('patch', "/v1/builds/#{id}", {data: {type: 'builds', id: id}.merge(encryption)})
    localizations = call('get', "/v1/builds/#{id}/betaBuildLocalizations")['data']
    unless localizations.any? { |l| l['attributes']['locale'] == 'en-US' }
      call('post', '/v1/betaBuildLocalizations', data: {type: 'betaBuildLocalizations', attributes: {locale: 'en-US', whatsNew: 'Improved first-time connection and startup reconnection. Please test pairing, reopening the app and terminal input.'}, relationships: {build: {data: {type: 'builds', id: id}}}})
    end
    attached = call('get', "/v1/builds/#{id}/betaGroups")['data'].any? { |g| g['id'] == group['id'] }
    call('post', "/v1/betaGroups/#{group['id']}/relationships/builds", data: [{type: 'builds', id: id}]) unless attached

    state = call('get', "/v1/builds/#{id}/buildBetaDetail")['data']['attributes']['externalBuildState']
    if state == 'READY_FOR_BETA_SUBMISSION'
      call('post', '/v1/betaAppReviewSubmissions', data: {type: 'betaAppReviewSubmissions', relationships: {build: {data: {type: 'builds', id: id}}}})
    elsif !%w[WAITING_FOR_BETA_REVIEW IN_BETA_REVIEW BETA_APPROVED READY_FOR_BETA_TESTING IN_BETA_TESTING].include?(state)
      raise "Distribution awaits Apple state update: #{state}; rerun after processing"
    end
    report[:externalBuildState] = call('get', "/v1/builds/#{id}/buildBetaDetail")['data']['attributes']['externalBuildState']
    report
  end
end

if __FILE__ == $PROGRAM_NAME
  report = TestFlightRelease.new(method(:api), ENV.fetch('RELEASE_VERSION'), ENV.fetch('BUILD_NUMBER'), apply: ENV['APPLY_DISTRIBUTION'] == 'true').run
  puts JSON.pretty_generate(report)
  File.write(ENV.fetch('REPORT_PATH', 'testflight-release.json'), JSON.pretty_generate(report) + "\n")
end
